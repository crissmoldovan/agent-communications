import { randomBytes, timingSafeEqual } from 'node:crypto';
import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  APPROVAL_LIFETIMES,
  type ApprovalRoute,
  bindingDigestOf,
  canonicalDisclosureBinding,
  type DisclosureBinding,
  type DisclosureBindingFields,
  type OwnerScope,
  pendingMsOf,
  requireKnownChannel,
  SENDING_LEASE_MS,
  sameDisclosureBinding,
} from './approval-binding.ts';
import { changePendingHint } from './approval-handoffs.ts';
import { registerStoreInternals } from './approval-internals.ts';
import { type ApprovalIo, NODE_APPROVAL_IO } from './approval-io.ts';
import { decodeLegacyV1, deriveLegacyV1State, type LegacyApprovalRecord } from './approval-legacy.ts';
import {
  ensurePruned,
  MAINTENANCE_RENEW_MS,
  MAINTENANCE_STALE_MS,
  type MaintenanceOptions,
  type MaintenanceStatus,
} from './approval-maintenance.ts';
import {
  type ApprovalObject,
  type ApprovalOutcome,
  approvalNotFound,
  approvalObjectOf,
  approvalOutcome,
  downloadClaimable,
  type LiveGate,
  liveGateOf,
  type OutcomeAction,
  type UsedSaid,
  withApproval,
} from './approval-outcome.ts';
import {
  channelOf,
  corruptStubOf,
  decodeStored,
  integrityRefusal,
  kindOf,
  ownerOf,
  type StoredApproval,
  stateOf,
} from './approval-stored.ts';
import { CLOCK_ANOMALY } from './approval-validate.ts';
import { AuditLog } from './audit.ts';
import { accountChannels } from './channel-words.ts';
import {
  type ChangePolicy,
  type Config,
  canonicalLoosening,
  type Loosening,
  type SendPolicy,
  type SettingChange,
  sameLoosening,
} from './config.ts';
import { canonicalJson, normaliseAddress, sha256Hex } from './digest.ts';
import { CommsError, type ErrorCode } from './errors.ts';
import { ensurePrivateDir, writeFileAtomic } from './fs.ts';
import { type CliHandoffs, handoffChoices, requiredHandoffs } from './handoff-text.ts';
import { APPROVAL_ID_PATTERN, challengeMatches, hashChallenge, newApprovalId, newChallenge } from './ids.ts';
import { withFileLock } from './lock.ts';
import type { RenameReason } from './saved-files.ts';

/**
 * Approval records bind a send to exactly one draft version. States:
 *
 *   pending ──approve──▶ approved ──claim──▶ sending ──▶ used | failed
 *      └──claim (effective policy chat)──────┘      └──▶ unknown (the process died mid-send)
 *   pending | approved ──▶ revoked ("voided": content changed, wrong inbox, too many wrong challenges, user revoked)
 *   expired is derived: a pending or approved record past its deadline reads as expired.
 *
 * Every transition is a compare-and-swap under a per-record lock. Single use does not rest on the lock alone: a claim
 * also creates `<id>.claim` with O_EXCL, which the file system guarantees only one process can do.
 *
 * A change approval (`kind: 'change'`) lives in the same store and goes through the same states, except that its
 * claim goes straight to `used`: what it permits is a write to the configuration, which the claimant makes itself.
 *
 * So does a download's question (`kind: 'download'`): where to save the files a Gmail or Slack download names. It is
 * held to the change policy of the mailbox or workspace it is about, as every other change there is. Under `chat` the
 * person's answer, relayed from the chat, claims it straight from `pending`. Under `confirm` it has to be answered
 * where an agent cannot answer for them — at their own terminal, or in a form a trusted client shows them — which
 * records the answer and moves it to `approved`; only then is it claimed, straight to `used`, and the recorded answer
 * is the one that saves. It gets the store's expiry, its single use and its binding for the reason a change does: an
 * answer given for three invoices must not save the next conversation's files, nor be spent twice.
 */

export type ApprovalState = 'pending' | 'approved' | 'sending' | 'used' | 'failed' | 'unknown' | 'expired' | 'revoked';
export type ApprovalChannel = 'elicitation' | 'terminal';

/**
 * What an approval permits: a send (a mail, a post, a reaction), a change to the configuration, or a download saved
 * where the person said.
 *
 * One store for all three, so a change gets the machinery a send already has — expiry, single use, the typed code —
 * and a kind on every record, so that none can be spent as another. Without it, a person who approved a post at a
 * terminal would also have approved whatever change an agent claimed under the same id.
 */
export type ApprovalKind = 'send' | 'change' | 'download' | 'disclosure';
export type {
  DisclosureActivationKind,
  DisclosureBinding,
  DisclosureVersion,
  DisclosureVersionKind,
} from './approval-binding.ts';

/** The inbox or account a change is about. `id` is absent when the change connects it, and it does not exist yet. */
export interface ChangeTarget {
  kind: 'inbox' | 'account';
  name: string;
  id?: string | undefined;
}

/**
 * Exactly what a change approval permits, stored on the record so a terminal can show it again and prove it is what
 * was prepared.
 */
export interface ChangeBinding {
  /** The caller's one line about the change, shown to the person. Not part of the digest: the lines below are. */
  summary: string;
  /** What it is about, or `null` for a change to the whole configuration. */
  target: ChangeTarget | null;
  /** Every safety setting it loosens, with the values `classifyChange` compared. Empty for a destructive change. */
  loosened: Loosening[];
  /**
   * Every setting it writes, loosened or tightened, with the values in the file before and after (`changedSettings`).
   *
   * Bound as well as the loosenings, because a preview shows the whole change: a claim that loosened the same thing
   * while dropping a tightening the person read would otherwise digest the same. Absent reads as none.
   */
  settings?: SettingChange[] | undefined;
  /** What it does outside the configuration, in words: a sign-in, a registration, files removed. */
  effects: string[];
  /**
   * What the call that prepared it already did at once, because it never waits for an approval — a narrowing beside
   * the change (design 2026-10-02 §D8). Not what approving does: the preview lists these apart, and its header says
   * the rest is what waits. A field of its own rather than words in `effects`, so no text a change carries — a label
   * a profile chose, say — can make a preview claim something was done.
   *
   * Bound when present, so a record cannot gain one it was not prepared with; absent reads as none, and leaves the
   * digest of every other change exactly what it was.
   */
  doneAtOnce?: string[] | undefined;
}

/**
 * Exactly which download a question was asked for, stored on the record so the answer can be held to it.
 *
 * The files are the ones the question listed, by the platform's own ids — `<message id>/<part id>` for Gmail, the file
 * id for Slack — in the order they were listed: a claim for any other set is a claim for a download the person was
 * not asked about. So are the names they would be saved under, in the same order: a Slack file renamed between the
 * question and the answer would otherwise be saved under a name the person was never shown. The folders are the two
 * the question showed, as absolute paths. They are not part of the digest, because they are what the answer *means*
 * rather than what it is for: `downloads` in the answer is the path the person read, even when an agent runs the
 * download again from another folder.
 */
export interface DownloadBinding {
  /** One line about the download, for a listing: "where to save 2 files from acme/gmail". Not part of the digest. */
  summary: string;
  /** The mailbox or workspace the files come from, by the id it has now. */
  target: { kind: 'inbox' | 'account'; name: string; id: string };
  /** Which download asked: `attachments.download`, `files.download`. */
  operation: string;
  /** The request as the caller made it, in the words of its own arguments: the selection, and how many at most. */
  request: Record<string, unknown>;
  /** The files the question listed, by the platform's ids, in order. */
  files: string[];
  /** The names those files would be saved under, as the question listed them, in the same order. */
  names: string[];
  /** The two folders the question offered, as absolute paths. */
  folders: { downloads: string; current: string };
  /**
   * The files as the question listed them to the person — the names they would be saved under, their sizes, why a
   * name has `.download` after it, and their risk flags — so a terminal or a form can show the question, and its
   * warnings, again. Not part of the digest: the ids and names above are.
   */
  listing?: ListedFile[] | undefined;
  /** The person's answer, when they gave it where an agent cannot: at a terminal, or in a trusted client's form. */
  answer?: RecordedSaveAnswer | undefined;
}

/** One file as a question lists it. */
export interface ListedFile {
  /** The name it would be saved under: the sender's made safe, with `.download` after it unless it is inert. */
  name: string;
  size: number | null;
  /** Why `.download` is after its name; absent when the name is the sender's, made safe. */
  renamed?: RenameReason | undefined;
  /** Its risk flags, as the file's own listing gives them. */
  flags?: string[] | undefined;
}

/**
 * An answer recorded on a question: one of the two folders it offered, or the folder the person named, as an absolute
 * path — resolved where they typed it, so it means the folder they read.
 */
export type RecordedSaveAnswer =
  | { readonly choice: 'downloads' | 'current' }
  | { readonly choice: 'other'; readonly folder: string };

/** What a claim of a download's question is held to: all of the binding but its summary and the folders it offered. */
export type DownloadRequest = Pick<DownloadBinding, 'target' | 'operation' | 'request' | 'files' | 'names'>;

/**
 * The digest a download's question is bound to: the account, the download, the request, the files it listed and the
 * names it showed them under.
 *
 * The files and names keep their order, since the question showed them in it; the request is canonical JSON, so the
 * same arguments digest the same however an object happened to list its keys.
 */
export function downloadDigest(download: DownloadRequest): string {
  return sha256Hex(
    canonicalJson({
      kind: 'download',
      target: { kind: download.target.kind, name: download.target.name, id: download.target.id },
      operation: download.operation,
      request: download.request,
      files: [...download.files],
      names: [...download.names],
    }),
  );
}

/**
 * Why a download claimed is not the one its question was asked for, in a sentence — the first difference found. Only
 * the words; what refuses is the digest.
 */
export function downloadDrift(asked: DownloadRequest, now: DownloadRequest): string {
  if (asked.target.id !== now.target.id || asked.target.kind !== now.target.kind) {
    return `the question was about ${asked.target.name}, not ${now.target.name}`;
  }
  if (asked.operation !== now.operation) return 'the question was asked for another kind of download';
  if (canonicalJson(asked.request) !== canonicalJson(now.request)) {
    return 'the question was asked about a different request: other messages, other files or another limit';
  }
  if (canonicalJson(asked.files) !== canonicalJson(now.files)) return 'the files are not the ones the question listed';
  // By its id, never by either name: a name is the sender's words, and this is the tool's sentence.
  const renamed = asked.files.find((_, index) => asked.names[index] !== now.names[index]);
  if (renamed !== undefined) {
    return `${renamed} would now be saved under another name than the one the question showed: it was renamed since`;
  }
  return 'the download is not the one the question was asked for';
}

/**
 * Why a download's question still waiting for its answer cannot be claimed with the live change policy `livePolicy`,
 * or null — decided by the download `claimable` matrix (`downloadClaimable`, design 2026-10-05 §D2): the policy the
 * question was asked under (`requiredPolicy`, stored when it was asked and never moved) and the live one. Changes
 * nothing, so a download can ask before it looks at a folder; the store decides again as it claims, by the same matrix,
 * against the live policy it reads under the question's lock. A question in any other state is refused for that state
 * by the claim, not here.
 *
 * While both are `chat`, nothing stops it: the person's answer, relayed from the conversation, is the answer. Anything
 * stricter needs the answer recorded on the question by a channel an agent cannot answer — the person's own terminal,
 * or a form a trusted client showed them. An answer carried in a tool's arguments or a command's flags is refused
 * however it was worded, with the command that answers it named, and the question left open for the person.
 */
export function downloadClaimRefusal(
  record: ApprovalRecord,
  livePolicy: ChangePolicy,
  pendingHint?: string,
): CommsError | null {
  if (record.state !== 'pending' || downloadClaimable(record, livePolicy)) return null;
  return downloadPendingRefusal(record, pendingHint);
}

/** The refusal of a question that waits for the person's own answer: refused, and left open for them to give it. */
function downloadPendingRefusal(record: ApprovalRecord, pendingHint?: string): CommsError {
  return refuseDownload(
    'APPROVAL_PENDING',
    'the change policy here is confirm, so the person answers where to save themselves — at their own terminal, not through an agent',
    record,
    pendingHint ??
      'Ask the person to answer it at their own terminal, with the approve command of the channel the files come from and this choice id; then make the download again with the choice id alone.',
  );
}

/** The kind of a record. Absent is a send: every version-1 send record was written without one. */
export function approvalKind(record: { kind?: ApprovalKind | undefined }): ApprovalKind {
  return record.kind ?? 'send';
}

/**
 * The digest a change approval is bound to: its target, every loosened path with its before and after values, every
 * setting it writes with its before and after values, and its effects.
 *
 * The loosenings and the settings are sorted, because their order is an implementation detail and the same change must
 * digest the same however it is listed. The effects are not: they are what the person read, in the order they read it.
 */
export function changeDigest(
  change: Pick<ChangeBinding, 'target' | 'loosened' | 'settings' | 'effects' | 'doneAtOnce'>,
): string {
  const target = change.target;
  return sha256Hex(
    canonicalJson({
      kind: 'change',
      target: target === null ? null : { kind: target.kind, name: target.name, id: target.id ?? null },
      loosened: change.loosened.map(canonicalLoosening).sort(),
      // The same four fields a loosening has, in the same canonical form.
      settings: (change.settings ?? []).map(canonicalLoosening).sort(),
      effects: [...change.effects],
      // Only when there is something: every change without one digests exactly as it did before the field existed.
      ...(change.doneAtOnce !== undefined && change.doneAtOnce.length > 0
        ? { doneAtOnce: [...change.doneAtOnce] }
        : {}),
    }),
  );
}

/**
 * Why `now` is not the change that was approved, in a sentence — the first difference found.
 *
 * Only the words of a refusal. What refuses is the digest; this says to the person, or the agent, which part moved,
 * because "prepare it again" with no reason reads as a fault rather than as the safety check it is.
 */
export function changeDrift(approved: ChangeBinding, now: ChangeBinding): string {
  const target = ({ target: of }: ChangeBinding) =>
    of === null ? null : canonicalJson({ kind: of.kind, name: of.name, id: of.id ?? null });
  if (target(approved) !== target(now)) {
    return approved.target !== null && now.target !== null && approved.target.name === now.target.name
      ? `"${now.target.name}" is not the ${now.target.kind} it was when this was approved`
      : 'it is about something other than what was approved';
  }
  const paths = (binding: ChangeBinding) =>
    binding.loosened
      .map((loosening) => loosening.path)
      .sort()
      .join('\n');
  if (paths(approved) !== paths(now)) return 'it loosens different settings from the ones approved';
  const moved = now.loosened.find((loosening) => !approved.loosened.some((ok) => sameLoosening(ok, loosening)));
  if (moved) return `${moved.path} would not move between the values that were approved`;
  // Either way round: a setting the person was shown and the claim leaves out, or one the claim adds.
  const unlike = (one: SettingChange[] | undefined, other: SettingChange[] | undefined) =>
    (one ?? []).find((setting) => !(other ?? []).some((ok) => sameLoosening(ok, setting)));
  const unset = unlike(approved.settings, now.settings) ?? unlike(now.settings, approved.settings);
  if (unset) return `it would not set ${unset.path} the way that was approved`;
  if (canonicalJson(approved.effects) !== canonicalJson(now.effects)) {
    return 'what it does outside the configuration is not what was approved';
  }
  if (canonicalJson(approved.doneAtOnce ?? []) !== canonicalJson(now.doneAtOnce ?? [])) {
    return 'what was done at once when it was prepared is not what this call says';
  }
  return 'the change is not the one that was approved';
}

/**
 * Bumped whenever what an approval binds changes; a record prepared under another version is refused.
 *
 * 2 from 0.14: a record binds its route, its lifetimes and its identity as well as its content (`bindingDigest`,
 * `approval-binding.ts`), so a record an earlier release wrote cannot be claimed here, nor one written here there.
 */
export const DIGEST_VERSION = 2;

export interface Expectation {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
}

export interface ApprovalRecord {
  approvalId: string;
  /** What it permits. Every version-2 record says, a send included; only a version-1 send was written without one. */
  kind: ApprovalKind;
  digestVersion: number;
  /** The manifest channel that made it (`gmail`, `slack`, `resend`, `whatsapp`, `core`), checked at creation. Bound. */
  channel: string;
  /** What `inboxId` names: an owner that existed, one the change creates, or none at all. Bound. */
  ownerScope: OwnerScope;
  /** A send's or a change's route, fixed at creation: a yes in the chat, or a person outside it. Bound. */
  route?: ApprovalRoute | undefined;
  /** How long it stays pending, from creation. Bound. */
  pendingMs: number;
  /** A send's or a change's lifetime once approved. Bound. */
  approvedMs?: number | undefined;
  /** For a change: the id of the inbox or account it is about, or empty for one to the whole configuration. */
  inboxId: string;
  inboxSub?: string | undefined;
  draftId: string;
  /** Changes on every save of the draft; binding to it detects any edit, even one that restores identical content. */
  draftMessageId: string;
  /** The outward content or change: the message, change or download digest. */
  contentDigest: string;
  /** The SHA-256 of everything the record binds (`bindingDigestOf`), recomputed from its own fields on every read. */
  bindingDigest: string;
  /** On a send: the owner's send epoch as it was read at prepare. Bound. */
  sendEpoch?: number | undefined;
  /**
   * A download's answer, bound: SHA-256 of canonical `{ bindingDigest, answer }`, written when a person answered at a
   * terminal or in a trusted form. Never on a send or a change, which carry `approvedBindingDigest` instead.
   */
  approvedDigest?: string | undefined;
  /** Where a person approved, or answered: the terminal, or a trusted client's form. Absent on a chat-route claim. */
  approvedVia?: ApprovalChannel | undefined;
  /** A send's or a change's approval: when, and the binding the person approved, which must still be the record's. */
  approvedAt?: string | undefined;
  /** `approvedAt + approvedMs`: until when an approved send or change may be claimed. */
  usableUntil?: string | undefined;
  approvedBindingDigest?: string | undefined;
  /** When a send was claimed for sending. Kept on every state after it. */
  sendingAt?: string | undefined;
  /** The sending claimant's latest lease renewal, when it has made one. */
  sendingHeartbeatAt?: string | undefined;
  /** When a record was used: for a send, the moment the provider accepted it, and equal to `sentAt`. */
  usedAt?: string | undefined;
  sentAt?: string | undefined;
  failedAt?: string | undefined;
  revokedAt?: string | undefined;
  /** The boundary that applied when it expired — or, on a `clock-anomaly` expiry, the time the clock was seen. */
  expiredAt?: string | undefined;
  /** Live policy at prepare time, for display and audit. */
  policy: SendPolicy;
  /** `confirm` when risk escalation raised this send. The effective policy is the stricter of this and the live one. */
  requiredPolicy: SendPolicy;
  riskFlags: string[];
  expect: Expectation;
  /** Hash of the challenge currently issued to a human; the challenge itself is never stored or returned. */
  challengeHash?: string | undefined;
  challengeAttempts: number;
  state: ApprovalState;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  sentMessageId?: string | undefined;
  reason?: string | undefined;
  /** For a change: exactly what it permits. `contentDigest` is `changeDigest` of this. */
  change?: ChangeBinding | undefined;
  /** For a download's question: what it asked about, and the folders it offered. `contentDigest` is `downloadDigest`. */
  download?: DownloadBinding | undefined;
  /** For a standing disclosure: the canonical, content-free event activation authority. */
  disclosure?: DisclosureBinding | undefined;
}

/**
 * The stored branch for standing disclosure. Its runtime decoder refuses every field belonging to send, change or
 * download records; this type is what the three disclosure-only methods return.
 */
export interface DisclosureApprovalRecord
  extends Omit<
    ApprovalRecord,
    | 'kind'
    | 'disclosure'
    | 'approvedVia'
    | 'channel'
    | 'ownerScope'
    | 'route'
    | 'inboxId'
    | 'inboxSub'
    | 'draftId'
    | 'draftMessageId'
    | 'contentDigest'
    | 'sendEpoch'
    | 'policy'
    | 'requiredPolicy'
    | 'riskFlags'
    | 'expect'
    | 'approvedBindingDigest'
    | 'sendingAt'
    | 'sendingHeartbeatAt'
    | 'sentAt'
    | 'sentMessageId'
    | 'failedAt'
    | 'change'
    | 'download'
  > {
  kind: 'disclosure';
  disclosure: DisclosureBinding;
  approvedVia?: 'terminal' | 'app' | undefined;
}

export interface CreateApprovalInput {
  /** The manifest channel preparing the send. A channel this release does not know is refused. */
  channel: string;
  inboxId: string;
  inboxSub?: string | undefined;
  draftId: string;
  draftMessageId: string;
  contentDigest: string;
  /** The owner's send epoch, read from the configuration at prepare (`sendEpochOf`). */
  sendEpoch: number;
  policy: SendPolicy;
  requiredPolicy: SendPolicy;
  riskFlags: string[];
  expect: Expectation;
}

export interface CreateChangeApprovalInput {
  /** The manifest channel of the surface preparing the change: `core` for core's own. */
  channel: string;
  change: ChangeBinding;
  /** The change policy in force before the change: it decides how the change is approved. */
  policy: ChangePolicy;
}

/** What a claimant of a change is about to write, and the change policy in force as it does. */
export interface LiveChange {
  change: ChangeBinding;
  policy: ChangePolicy;
}

/** What the caller observed in the live draft at the moment of a transition. */
export interface LiveDraft {
  draftMessageId: string;
  contentDigest: string;
}

/** What the product making a claim tells the store about itself. */
export interface ClaimOptions {
  /** The shell syntax used by any approval command this refusal prints. */
  platform?: NodeJS.Platform | undefined;
  /**
   * The commands the printing package gives a person (`core.handoffs`), for a refusal that names one: the store's own
   * when left out. With neither, a refusal that has to name one is a programming error (`requiredHandoffs`).
   */
  handoffs?: CliHandoffs | undefined;
  /**
   * What the caller is told when the send is waiting for a person: which command approves it, and what to run after.
   *
   * The product's to say, because the store is shared and the command that approves is not. The store used to say
   * it itself, in Gmail's words, so a Slack post held for approval told the agent to hand the person
   * `agent-gmail approve` — which cannot approve a Slack record — or to "send it from Gmail". Left out, the hint
   * names no product at all rather than the wrong one.
   */
  pendingHint?: string | undefined;
  /**
   * How a used send is said in the refusal of a claim of it — the surface's own words, as `pendingHint` is (design
   * 2026-10-05 §D2's used-send row): "sent at …" when left out, as Gmail and Slack say it.
   */
  usedSaid?: UsedSaid | undefined;
  /**
   * The caller's cancellation — an MCP request's signal — asked under the record's lock, immediately before the claim
   * would change the record.
   *
   * A claim can wait: for the lock, while another process holds it. A caller that looked at its signal before calling
   * and found it clear could be cancelled during that wait, and the claim then went through all the same, spending an
   * approval on a call nobody was waiting for any more — whose outcome its caller then had to record as a failure,
   * since a claim cannot be put back. Asked here, a cancellation that lands before the record changes leaves it exactly
   * as it was, for the same call made again; one that lands after is the caller's to handle, as it always was.
   */
  signal?: AbortSignal | undefined;
}

export const MAX_CHALLENGE_ATTEMPTS = 3;
/** The reason a `sending` record reads `unknown` with when its lease ran out; a late completion replaces it. */
export const STALE_LEASE_REASON = 'the sending process stopped before recording an outcome';

/** What a send's claim gives its claimant: the record, and the private token only the claimant holds (`heartbeat`, `fence`, `complete`). */
export interface SendClaim {
  readonly record: ApprovalRecord;
  /**
   * 16 random bytes, hex: kept only in the claim's `O_EXCL` marker beside the record, and handed only to the call
   * that claimed. Never in a record, a view, an approval object, an audit row, an error or a result.
   */
  readonly claimToken: string;
  /** Where the approval stands now that it is claimed (design 2026-10-05 §D8): `sending`, never claimable. */
  readonly approval: ApprovalObject;
}

/** A send's outcome, as only its claimant records it. */
export type SendOutcome = { readonly sentMessageId: string } | { readonly error: string };
const POLICY_RANK: Record<SendPolicy, number> = { chat: 0, confirm: 1, never: 2 };

/** The stricter of two policies. */
export function stricterPolicy(a: SendPolicy, b: SendPolicy): SendPolicy {
  return POLICY_RANK[a] >= POLICY_RANK[b] ? a : b;
}

/** What a refusal repeats of the record it refuses: its id and its state. */
type Refused = Pick<ApprovalRecord, 'approvalId' | 'state'>;

function refuse(code: ErrorCode, reason: string, record?: Refused, hint?: string): CommsError {
  return new CommsError(code, `nothing was sent: ${reason}`, {
    hint: hint ?? 'Prepare the send again and show the new preview to the user.',
    details: record ? { approvalId: record.approvalId, state: record.state } : {},
  });
}

/** What one locked transition leaves: the record as written, and where it stands, classified in that same lock. */
interface Transitioned {
  readonly record: ApprovalRecord;
  readonly approval: ApprovalObject;
}

/** A refusal made after a transition wrote its record, carrying that record's object (decision 8). */
function refusedAfter(error: CommsError, transitioned: Transitioned): CommsError {
  return withApproval(error, transitioned.approval) as CommsError;
}

/** The same refusal for a change, which sends nothing and so must not say that it did not. */
function refuseChange(code: ErrorCode, reason: string, record?: Refused, hint?: string): CommsError {
  return new CommsError(code, `nothing was changed: ${reason}`, {
    hint: hint ?? 'Prepare the change again and show the new preview to the user.',
    details: record ? { approvalId: record.approvalId, state: record.state } : {},
  });
}

/**
 * The same refusal for a download's question, which saves nothing until it is claimed.
 *
 * Its hint says to ask again rather than to prepare anything: what the person is shown again is the question, and it
 * is the download itself that asks it.
 */
function refuseDownload(code: ErrorCode, reason: string, record?: Refused, hint?: string): CommsError {
  return new CommsError(code, `nothing was saved: ${reason}`, {
    hint: hint ?? 'Make the download again without an answer, and show the person the new question.',
    details: record ? { choiceId: record.approvalId, state: record.state } : {},
  });
}

/** The disclosure path has no send, draft or provider outcome: its refusal must never imply one. */
function refuseDisclosure(code: ErrorCode, reason: string, record?: Refused, hint?: string): CommsError {
  return new CommsError(code, `nothing was disclosed: ${reason}`, {
    hint:
      hint ?? 'Prepare a new standing disclosure authorisation and show its exact activation preview to the person.',
    details: record ? { approvalId: record.approvalId, state: record.state } : {},
  });
}

/** The refusal in the words of the record's own kind. */
function refusalFor(record: { kind?: ApprovalKind | undefined }): typeof refuse {
  const kind = approvalKind(record);
  switch (kind) {
    case 'send':
      return refuse;
    case 'change':
      return refuseChange;
    case 'download':
      return refuseDownload;
    case 'disclosure':
      return refuseDisclosure;
  }
}

/** Whether a record was prepared under this release's digest version: only such a record is ever claimed or approved. */
export function isCurrentDigestVersion(record: { digestVersion?: unknown }): boolean {
  return record.digestVersion === DIGEST_VERSION;
}

/**
 * The refusal of a record prepared under another digest version, in the words of its own kind: the one every locked
 * transition gives, for a caller that has to refuse it before it reads anything else — a draft, a room, a message.
 */
export function otherVersionRefusal(record: Refused & { kind?: ApprovalKind | undefined }): CommsError {
  return refusalFor(record)(
    'APPROVAL_VOID',
    'the approval was prepared by a different version of agent-communications',
    record,
  );
}

/**
 * Whose decision a revoke carries, which decides what it may do to a record from an earlier release (version 1).
 *
 * `person` — a person cancelled it, from a tool, a command or a terminal. `lifecycle` — the owner it belongs to is being
 * removed, which a person approved. Either retires a version-1 record in its own shape (`revokeLegacy`), so a running
 * earlier release can no longer claim it. `integrity` — this release found the record does not match what it binds:
 * that never rewrites a version-1 record, which this release cannot judge by its own rules, and gets the version
 * refusal instead. For a version-2 record all three revoke alike.
 */
export type RevokeDisposition = 'person' | 'lifecycle' | 'integrity';

/**
 * A claim whose caller was cancelled before it changed anything (`ClaimOptions.signal`).
 *
 * `USAGE` and `cancelled:`, the words every cancellation in this repository is reported in, with `details.reason`
 * saying so for a caller that branches on it — and in the record's own kind: a question is not an approval, and
 * nothing is sent by answering one. The record is as it was, and the hint says so.
 */
function cancelledClaim(record: ApprovalRecord): CommsError {
  const kind = approvalKind(record);
  switch (kind) {
    case 'send':
      return new CommsError('USAGE', 'cancelled: nothing was sent', {
        hint: 'The approval was not used: the same call, made again, can still use it until it expires.',
        details: { approvalId: record.approvalId, state: record.state, reason: 'cancelled' },
      });
    case 'change':
      return new CommsError('USAGE', 'cancelled: nothing was changed', {
        hint: 'The approval was not used: the same call, made again, can still use it until it expires.',
        details: { approvalId: record.approvalId, state: record.state, reason: 'cancelled' },
      });
    case 'download':
      return new CommsError('USAGE', 'cancelled: nothing was saved', {
        hint: 'The question was not used: the same call, made again with the same answer, can still use it until it expires.',
        details: { choiceId: record.approvalId, state: record.state, reason: 'cancelled' },
      });
    case 'disclosure':
      return new CommsError('USAGE', 'cancelled: nothing was disclosed', {
        hint: 'The standing disclosure approval was not used: it can still be completed until it expires.',
        details: { approvalId: record.approvalId, state: record.state, reason: 'cancelled' },
      });
  }
}

/** The refusal of a renewal or an outcome from a call that does not hold the send's claim. It names no token. */
function notTheClaim(approvalId: string): CommsError {
  return new CommsError(
    'UNEXPECTED',
    `nothing was recorded: this call does not hold the claim on approval ${approvalId}`,
    {
      hint: 'Only the call that claimed a send renews it or records its outcome. This is a bug — please report it.',
      details: { approvalId },
    },
  );
}

/**
 * The record without its challenge hash, every other field as stored — what a sender wrote included, outside any
 * envelope. Not for a result: a result shows an approval through `publicApproval` (design 2026-10-05 §D8).
 */
export function publicView(record: ApprovalRecord): Omit<ApprovalRecord, 'challengeHash'> {
  const { challengeHash: _hidden, ...rest } = record;
  return rest;
}

type Failure = { code: ErrorCode; reason: string };

/**
 * What an agent is told when a change waits for a person at a terminal, for a claim made with no surface's words: the
 * printing package's own `approve` with this id and its wait, as the command line takes them — each located, or why
 * there is none here.
 */
function approvePendingHint(
  handoffs: CliHandoffs | undefined,
  approvalId: string,
  platform: NodeJS.Platform | undefined,
): string {
  const located = requiredHandoffs(handoffs);
  return changePendingHint(located.on(platform ?? located.platform), 'cli', approvalId);
}

/**
 * What approves the send `approvalId`: the `approve` of every channel that sends, one of which prepared it — a send
 * record does not say which (D1). Each is a located command, or why it has none here.
 */
export function sendApprovesHint(maker: CliHandoffs, approvalId: string): string {
  const sending = accountChannels().filter((manifest) => manifest.accounts?.modes.includes('send') === true);
  return `It is approved with the command that prepared it — ${handoffChoices(
    sending.map((manifest) => maker.of(manifest.channel, ['approve', approvalId])),
    'and none is locatable here:',
  )} — and permits only that send.`;
}

/**
 * What a caller takes an id to be: an approval of `kind` (any kind when left out); on a channel's own surface that is
 * no one owner's — its terminal approval — one of `channel`'s, the manifest channel that prepared it; and on a surface
 * pinned to one mailbox or account, or a claim made for one, owned by `owner`. Anything else is the one `NOT_FOUND`
 * (`approvalNotFound`), checked before the record's state is looked at: another channel's send given to Gmail's
 * `approve` is not found there, as one nobody prepared is not (design 2026-10-05 §D2).
 */
export interface ApprovalExpectation {
  readonly kind?: ApprovalKind | undefined;
  readonly channel?: string | undefined;
  readonly owner?: string | undefined;
}

/**
 * Whether the caller may be told of `found`: it is the kind, the channel and the owner the caller expects. A record
 * whose kind or owner cannot be trusted — unreadable, or corrupt with an unverifiable binding — is never shown to a
 * pinned caller, and reaches an unpinned one only as its stub (the integrity refusal). One whose channel cannot be told
 * — an earlier release's whose account is gone — is no channel's own.
 */
function matchesExpectation(found: StoredApproval, expect: ApprovalExpectation): boolean {
  const kind = kindOf(found);
  const owner = ownerOf(found);
  if (kind === null) return expect.owner === undefined;
  // Disclosure has no channel or mailbox owner. It is still a real, typed record, never a send-shaped fallback.
  if (kind === 'disclosure') {
    return (
      (expect.kind === undefined || expect.kind === 'disclosure') &&
      expect.channel === undefined &&
      expect.owner === undefined
    );
  }
  if (owner === null) return expect.owner === undefined;
  if (expect.kind !== undefined && kind !== expect.kind) return false;
  if (expect.channel !== undefined && channelOf(found) !== expect.channel) return false;
  return expect.owner === undefined || owner === expect.owner;
}

/** How the store is opened. */
export interface ApprovalStoreOptions {
  now?: () => Date;
  handoffs?: CliHandoffs | undefined;
  /**
   * The configuration, read afresh: the one thing a read of the store consults beyond the files themselves — to
   * attribute a version-1 record whose owner is an account to that account's platform, and for every locked
   * transition, the live gate it classifies by (`liveGateOf`): the owner, its policies and its send epoch. Read once
   * per `get`, once per `list`, and once per locked transition after its lock is held, so one call decodes and
   * classifies against one snapshot. Its errors propagate: a configuration that cannot be read is never taken for none.
   * Resolving `null`, or left out, is "no configuration": a version-1 account record is then unattributable, nothing is
   * ever claimable, and a claim, an approval or an answer is refused with `CONFIG`.
   */
  loadConfig?: (() => Promise<Config | null>) | undefined;
  /**
   * The audit log daily retention records each deletion in (`approval.retained`, design 2026-10-05 §D9): the state
   * directory's own when left out. `openCore` passes the one it opens.
   */
  audit?: Pick<AuditLog, 'append'> | undefined;
  /**
   * The file operations daily maintenance and the unsent report go through — the real ones when left out; a test's to
   * count and interrupt every step. Every other read and write of the store is unaffected.
   */
  io?: ApprovalIo | undefined;
}

export class ApprovalStore {
  readonly directory: string;
  readonly #now: () => Date;
  readonly #handoffs: CliHandoffs | undefined;
  readonly #loadConfig: (() => Promise<Config | null>) | undefined;

  constructor(stateDir: string, options: ApprovalStoreOptions = {}) {
    this.directory = join(stateDir, 'approvals');
    this.#handoffs = options.handoffs;
    this.#now = options.now ?? (() => new Date());
    this.#loadConfig = options.loadConfig;
    registerStoreInternals(this, {
      directory: this.directory,
      now: () => this.#now(),
      loadConfig: () => this.#config(),
      derive: (record) => this.#derive(record),
      io: options.io ?? NODE_APPROVAL_IO,
      audit: options.audit ?? new AuditLog(stateDir, () => this.#now()),
      timings: { staleMs: MAINTENANCE_STALE_MS, renewMs: MAINTENANCE_RENEW_MS, recordStaleMs: 30_000 },
    });
  }

  /**
   * Daily retention (design 2026-10-05 §D9): once a day per state directory, a bounded batch deletes valid finished
   * records ninety days past their finish. Awaited before every creation, list, status and wait — with its own
   * five-second budget — and before a report, on the report's shared deadline. Never a gate: whatever it finds, it
   * returns its status and the caller goes on.
   */
  ensurePruned(options: MaintenanceOptions = {}): Promise<MaintenanceStatus> {
    return ensurePruned(this, options);
  }

  #path(approvalId: string, suffix = '.json'): string {
    if (!APPROVAL_ID_PATTERN.test(approvalId)) throw refuse('USAGE', `"${approvalId}" is not an approval id`);
    return join(this.directory, `${approvalId}${suffix}`);
  }

  /** The configuration snapshot one read decodes against, or null without a loader. Its errors propagate. */
  async #config(): Promise<Config | null> {
    return this.#loadConfig === undefined ? null : await this.#loadConfig();
  }

  /** One approval file, decoded into one of its four forms (`decodeStored`), or null when there is none. */
  async #read(approvalId: string, config: Config | null): Promise<StoredApproval | null> {
    let text: string;
    try {
      text = await readFile(this.#path(approvalId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return decodeStored(approvalId, text, config, this.#now());
  }

  async #write(record: ApprovalRecord | LegacyApprovalRecord): Promise<void> {
    await writeFileAtomic(this.#path(record.approvalId), `${JSON.stringify(record, null, 2)}\n`);
  }

  /**
   * Derived states (design 2026-10-05 §D1, "Version-2 timestamps fail closed"): expiry for an active record, and
   * `unknown` for a send whose claimant stopped renewing its lease (`SENDING_LEASE_MS`).
   *
   * Only `pending` and `approved` expire. A pending record expires at `expiresAt` — its route's lifetime from creation,
   * ten minutes on `chat` and thirty on `confirm` — and an approved send or change at `usableUntil`, a day from its
   * approval, so a person's approval does not run out with the window it was given in. A download's question has no
   * window of its own: answered or not, it expires at `expiresAt`. Equality is expired, and `expiredAt` is the boundary
   * that applied, never the moment it was noticed.
   *
   * A clock seen before the record was made, or before it was approved, expires it at once: stepped backwards — an NTP
   * correction, a resumed VM, a person changing the date — it must never put an expired record back in play, nor be
   * trusted to measure one. That expiry says so (`reason: 'clock-anomaly'`) and records when the clock was seen, and
   * claims no deadline it did not reach.
   */
  #derive(record: ApprovalRecord): ApprovalRecord {
    const observed = this.#now();
    const now = observed.getTime();
    if (record.state === 'pending' || record.state === 'approved') {
      const approvedAt = record.state === 'approved' ? record.approvedAt : undefined;
      if (now < Date.parse(record.createdAt) || (approvedAt !== undefined && now < Date.parse(approvedAt))) {
        return { ...record, state: 'expired', reason: CLOCK_ANOMALY, expiredAt: observed.toISOString() };
      }
      const deadline =
        record.state === 'approved' && record.kind !== 'download' && record.usableUntil !== undefined
          ? record.usableUntil
          : record.expiresAt;
      if (now >= Date.parse(deadline)) {
        return { ...record, state: 'expired', reason: 'the approval window passed', expiredAt: deadline };
      }
      return record;
    }
    // The sending lease: from the claimant's last renewal, or its claim. At the boundary, its outcome is unknown.
    const renewed = record.state === 'sending' ? (record.sendingHeartbeatAt ?? record.sendingAt) : undefined;
    if (renewed !== undefined && now >= Date.parse(renewed) + SENDING_LEASE_MS) {
      return { ...record, state: 'unknown', reason: STALE_LEASE_REASON };
    }
    return record;
  }

  /** A version-1 record as its own release derived it: the state only, nothing written (`deriveLegacyV1State`). */
  #deriveLegacy(record: LegacyApprovalRecord): LegacyApprovalRecord {
    const derived = deriveLegacyV1State(record, this.#now());
    if (derived.state === record.state) return record;
    return { ...record, state: derived.state, ...(derived.reason === undefined ? {} : { reason: derived.reason }) };
  }

  /** A stored record as it reads now: a version-2 record's derived state applied (not written); every other as is. */
  #derived(stored: StoredApproval): StoredApproval {
    return stored.form === 'v2' ? { form: 'v2', record: this.#derive(stored.record) } : stored;
  }

  /**
   * A record's binding, recomputed from its own fields, written as the last field set — and `kind`, `channel` and the
   * profile checked first, so nothing is written that names a channel this release does not know.
   */
  #bound(record: Omit<ApprovalRecord, 'bindingDigest'>): ApprovalRecord {
    if (record.kind === 'disclosure') {
      const disclosure = canonicalDisclosureBinding(record.disclosure as DisclosureBinding);
      return {
        ...record,
        disclosure,
        bindingDigest: bindingDigestOf({
          approvalId: record.approvalId,
          kind: 'disclosure',
          disclosure,
        } satisfies DisclosureBindingFields),
      };
    }
    requireKnownChannel(record.channel);
    return { ...record, bindingDigest: bindingDigestOf(record) };
  }

  async create(input: CreateApprovalInput): Promise<ApprovalRecord> {
    // A provider's digest is lowercase hex SHA-256, the only encoding a version-2 record holds: anything else would be
    // written as a record that reads back corrupt.
    if (!/^[0-9a-f]{64}$/.test(input.contentDigest)) {
      throw new CommsError('UNEXPECTED', 'an approval is bound to a SHA-256 of what it permits, and this is not one', {
        hint: 'This is a bug — please report it.',
      });
    }
    requireKnownChannel(input.channel);
    // The day's retention first, bounded: a creation goes on whatever it finds.
    await this.ensurePruned();
    const now = this.#now();
    const requiredPolicy = stricterPolicy(input.policy, input.requiredPolicy);
    // The route is fixed here, and never moves: a person outside the chat when the policy or an escalation says so.
    const route: ApprovalRoute = requiredPolicy === 'confirm' ? 'confirm' : 'chat';
    const pendingMs = pendingMsOf(route);
    // Built field by field: nothing a caller passes can set the id, the state or a challenge.
    const record = this.#bound({
      approvalId: newApprovalId(),
      kind: 'send',
      digestVersion: DIGEST_VERSION,
      channel: input.channel,
      ownerScope: 'owner',
      route,
      pendingMs,
      approvedMs: APPROVAL_LIFETIMES.approved,
      inboxId: input.inboxId,
      inboxSub: input.inboxSub,
      draftId: input.draftId,
      draftMessageId: input.draftMessageId,
      contentDigest: input.contentDigest,
      sendEpoch: input.sendEpoch,
      policy: input.policy,
      requiredPolicy,
      riskFlags: [...input.riskFlags],
      expect: {
        to: [...input.expect.to],
        cc: [...input.expect.cc],
        bcc: [...input.expect.bcc],
        subject: input.expect.subject,
      },
      challengeAttempts: 0,
      state: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + pendingMs).toISOString(),
      updatedAt: now.toISOString(),
    });
    await this.#write(record);
    return record;
  }

  /** Creates only a pending standing disclosure approval from a daemon-derived canonical binding. */
  async createDisclosure(binding: DisclosureBinding): Promise<DisclosureApprovalRecord> {
    await this.ensurePruned();
    const disclosure = canonicalDisclosureBinding(binding);
    const now = this.#now();
    const pendingMs = APPROVAL_LIFETIMES.confirm;
    const record = this.#bound({
      approvalId: newApprovalId(),
      kind: 'disclosure',
      digestVersion: DIGEST_VERSION,
      pendingMs,
      approvedMs: APPROVAL_LIFETIMES.approved,
      disclosure,
      challengeAttempts: 0,
      state: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + pendingMs).toISOString(),
      updatedAt: now.toISOString(),
    } as Omit<ApprovalRecord, 'bindingDigest'>) as DisclosureApprovalRecord;
    await this.#write(record as ApprovalRecord);
    return record;
  }

  /**
   * One approval, in whichever of its four forms it is (`StoredApproval`), read against one configuration snapshot —
   * or null when there is none. Nothing is written.
   */
  async get(approvalId: string): Promise<StoredApproval | null> {
    const config = await this.#config();
    const stored = await this.#read(approvalId, config);
    return stored === null ? null : this.#derived(stored);
  }

  /**
   * Compare-and-swap under the record's lock, classified there (design 2026-10-05 §D2).
   *
   * Under the lock, in this order: the configuration is read once (`loadConfig`), the file is read and decoded against
   * it, and the record must be what the caller expects — its kind, its owner — or the call gets the one `NOT_FOUND`,
   * before anything of the record's state is looked at. A record from an earlier release then gets the version
   * refusal, a corrupt or unreadable one the integrity refusal, and neither is ever rewritten. A version-2 record is
   * derived (expiry, a dead send) and classified (`approvalOutcome`) against the live gate of that one configuration
   * read; what it derives is written before `decide` runs — expiry and `unknown` always, a revocation the
   * classification derived only for an action, never for a look. `decide` gets the record as it now stands, its
   * outcome and the live gate, and returns the next record (written) or throws (nothing more written).
   *
   * What it returns, and every refusal thrown from inside it, says where the approval stands (decision 8): the object
   * of the record as `decide` left it, or as it stood when `decide` refused — classified against the same live gate.
   */
  async #transition(
    approvalId: string,
    expect: ApprovalExpectation,
    action: OutcomeAction,
    decide: (current: ApprovalRecord, outcome: ApprovalOutcome, live: LiveGate | null) => ApprovalRecord,
    options: { claimToken?: string | undefined; usedSaid?: UsedSaid | undefined } = {},
  ): Promise<Transitioned> {
    const path = this.#path(approvalId);
    return withFileLock(`${path}.lock`, async () => {
      const config = await this.#config();
      const found = await this.#read(approvalId, config);
      if (found === null || !matchesExpectation(found, expect)) throw approvalNotFound(approvalId, expect.kind);
      const derived = this.#derived(found);
      const live = config === null || derived.form !== 'v2' ? null : liveGateOf(config, derived.record);
      const outcome = approvalOutcome(derived, { action, live, now: this.#now(), usedSaid: options.usedSaid });
      if (found.form !== 'v2' || derived.form !== 'v2' || outcome.record === null) {
        throw outcome.error ?? integrityRefusal(found);
      }
      // Only the call that claimed a send may renew or finish it: checked against the claim's marker, under this lock,
      // before anything is written.
      if (options.claimToken !== undefined && !(await this.#holdsClaim(approvalId, options.claimToken))) {
        throw notTheClaim(approvalId);
      }
      const stored = found.record;
      const current = outcome.revokes && action !== 'inspect' && action !== 'wait' ? outcome.record : derived.record;
      if (current.state !== stored.state) await this.#write({ ...current, updatedAt: this.#now().toISOString() });
      const objectOf = (record: ApprovalRecord) => approvalObjectOf(record, live, this.#now());
      let next: ApprovalRecord;
      try {
        next = decide(current, outcome, live);
      } catch (error) {
        throw withApproval(error, objectOf(current));
      }
      if (next !== current) await this.#write({ ...next, updatedAt: this.#now().toISOString() });
      return { record: next, approval: objectOf(next) };
    });
  }

  /**
   * A look at one approval, under its lock: the record as it stands and its classification for `expect` — the same
   * `NOT_FOUND` as every action for an id that is not what the caller expects, before anything of the record is
   * classified. It writes only what reading derives (an expiry, a dead send's `unknown`), never a revocation: an owner
   * removed or a stale epoch is shown as revoked here, and written by the next action.
   *
   * `action` is for a surface about to act on what it reads — a terminal about to show a preview, an execute about to
   * read its draft — classified for that action (`approve`, `claim`, `revoke`), so the refusal is the one the action
   * would get. A revocation the classification derives for it is written then, as the action itself would write it:
   * the first locked action persists it, and this is that action's first step (design 2026-10-05 §D2).
   */
  async inspect(
    approvalId: string,
    expect: ApprovalExpectation = {},
    options: { action?: OutcomeAction | undefined; usedSaid?: UsedSaid | undefined } = {},
  ): Promise<{ stored: StoredApproval; outcome: ApprovalOutcome }> {
    const action = options.action ?? 'inspect';
    const path = this.#path(approvalId);
    return withFileLock(`${path}.lock`, async () => {
      const config = await this.#config();
      const found = await this.#read(approvalId, config);
      if (found === null || !matchesExpectation(found, expect)) throw approvalNotFound(approvalId, expect.kind);
      const derived = this.#derived(found);
      const live = config === null || derived.form !== 'v2' ? null : liveGateOf(config, derived.record);
      const outcome = approvalOutcome(derived, { action, live, now: this.#now(), usedSaid: options.usedSaid });
      if (found.form === 'v2' && derived.form === 'v2') {
        const acting = outcome.revokes && action !== 'inspect' && action !== 'wait' && outcome.record !== null;
        const current = acting && outcome.record !== null ? outcome.record : derived.record;
        if (current.state !== found.record.state) {
          await this.#write({ ...current, updatedAt: this.#now().toISOString() });
        }
        return { stored: { form: 'v2', record: current }, outcome };
      }
      return { stored: derived, outcome };
    });
  }

  /**
   * D8's object for a record a call has just written, claimed or finished — what its result reports. Classified as a
   * look at it would be, against a fresh read of the configuration, without the lock and writing nothing: what decided
   * was the transition that wrote it. A configuration that cannot be read leaves only what the record says (nothing
   * claimable): a report never fails the call it reports on, least of all one that has already sent.
   */
  async approvalOf(record: ApprovalRecord): Promise<ApprovalObject> {
    let live: LiveGate | null = null;
    try {
      const config = await this.#config();
      live = config === null ? null : liveGateOf(config, record);
    } catch {
      live = null;
    }
    return approvalObjectOf(this.#derive(record), live, this.#now());
  }

  /**
   * The classification of a record a call has just written, in any of its forms — a revoke's, a cancel's — for its
   * result to show through `publicApproval`, as a status, a wait and a list show theirs: what a sender wrote only inside
   * the untrusted-content envelope (design 2026-10-05 §D8). Classified as a look at it would be, against a fresh read of
   * the configuration, without the lock and writing nothing, as `approvalOf` is; a configuration that cannot be read
   * leaves nothing claimable, and never fails the call it reports on.
   */
  async outcomeOf(stored: StoredApproval): Promise<ApprovalOutcome> {
    const derived = this.#derived(stored);
    let live: LiveGate | null = null;
    if (derived.form === 'v2') {
      try {
        const config = await this.#config();
        live = config === null ? null : liveGateOf(config, derived.record);
      } catch {
        live = null;
      }
    }
    return approvalOutcome(derived, { action: 'inspect', live, now: this.#now() });
  }

  /**
   * The refusal of a second approval of a record a person approved already: there is nothing to approve, and the
   * approval can be used as it is.
   */
  #alreadyApproved(record: ApprovalRecord, outcome: ApprovalOutcome): CommsError {
    const detail = { approvalId: record.approvalId, state: record.state, approval: outcome.approval };
    switch (record.kind) {
      case 'send':
        return new CommsError('USAGE', 'nothing was sent: it is approved already, and a person approves it once', {
          hint: 'Nothing more is needed from the person: try the same call again with the same approval.',
          details: detail,
        });
      case 'change':
        return new CommsError('USAGE', 'nothing was changed: it is approved already, and a person approves it once', {
          hint: 'Nothing more is needed from the person: try the same call again with the same approval.',
          details: detail,
        });
      case 'download':
        return new CommsError('USAGE', 'nothing was saved: it is approved already, and a person approves it once', {
          hint: 'Nothing more is needed from the person: try the same call again with the same approval.',
          details: detail,
        });
      case 'disclosure':
        return new CommsError('USAGE', 'nothing was disclosed: it is approved already, and a person approves it once', {
          hint: 'Nothing more is needed from the person: complete the same activation with the same approval.',
          details: detail,
        });
    }
  }

  /** Issues a new challenge to show a human; only its hash is kept. */
  async issueChallenge(
    approvalId: string,
    kind: ApprovalKind = 'send',
    // Kept for callers that pass it: a refusal here names no command since another kind's id became `NOT_FOUND`.
    _platform: NodeJS.Platform = process.platform,
    options: { usedSaid?: UsedSaid | undefined } = {},
  ): Promise<string> {
    if (kind === 'disclosure') {
      throw new CommsError(
        'APPROVAL_REQUIRED',
        'nothing was disclosed: a standing disclosure challenge is only issued to the trusted terminal or app route',
      );
    }
    const challenge = newChallenge();
    await this.#transition(
      approvalId,
      { kind },
      'approve',
      (current, outcome) => {
        if (outcome.error) throw outcome.error;
        if (current.state !== 'pending') throw this.#alreadyApproved(current, outcome);
        return { ...current, challengeHash: hashChallenge(challenge) };
      },
      { usedSaid: options.usedSaid },
    );
    return challenge;
  }

  /** Issues the typed challenge that a terminal or the trusted desktop app must answer for disclosure. */
  async issueDisclosureChallenge(approvalId: string): Promise<string> {
    const challenge = newChallenge();
    await this.#transition(approvalId, { kind: 'disclosure' }, 'approve', (current, outcome) => {
      if (outcome.error) throw outcome.error;
      if (current.state !== 'pending') throw this.#alreadyApproved(current, outcome);
      return { ...current, challengeHash: hashChallenge(challenge) };
    });
    return challenge;
  }

  /**
   * Approves one exact standing disclosure authority. MCP/chat forms are never an approval channel here: `app` means
   * the desktop application's trusted typed-challenge bridge, not a client form.
   */
  async approveDisclosure(
    approvalId: string,
    liveBinding: DisclosureBinding,
    answer: string,
    via: 'terminal' | 'app',
  ): Promise<DisclosureApprovalRecord> {
    let failure: Failure | null = null;
    const done = await this.#transition(approvalId, { kind: 'disclosure' }, 'approve', (current, outcome) => {
      if (outcome.error) throw outcome.error;
      if (current.state !== 'pending') throw this.#alreadyApproved(current, outcome);
      if (via !== 'terminal' && via !== 'app') {
        throw new CommsError(
          'APPROVAL_REQUIRED',
          'nothing was disclosed: approval is only at the terminal or the trusted app',
          {
            details: { approvalId: current.approvalId, state: current.state },
          },
        );
      }
      if (!current.challengeHash) {
        throw new CommsError('APPROVAL_REQUIRED', 'nothing was disclosed: no challenge was issued for this approval', {
          details: { approvalId: current.approvalId, state: current.state },
        });
      }
      const at = this.#now();
      const binding = current.disclosure as DisclosureBinding;
      if (!sameDisclosureBinding(binding, liveBinding)) {
        failure = { code: 'APPROVAL_VOID', reason: 'the disclosure binding changed after it was prepared' };
        return {
          ...current,
          state: 'revoked',
          reason: failure.reason,
          revokedAt: at.toISOString(),
          challengeHash: undefined,
        };
      }
      if (!challengeMatches(answer, current.challengeHash)) {
        const attempts = current.challengeAttempts + 1;
        if (attempts >= MAX_CHALLENGE_ATTEMPTS) {
          failure = { code: 'APPROVAL_VOID', reason: 'too many wrong answers to the challenge' };
          return {
            ...current,
            challengeAttempts: attempts,
            state: 'revoked',
            reason: failure.reason,
            revokedAt: at.toISOString(),
          };
        }
        failure = { code: 'APPROVAL_REQUIRED', reason: 'the challenge did not match' };
        return { ...current, challengeAttempts: attempts };
      }
      return {
        ...current,
        state: 'approved',
        approvedVia: via,
        approvedAt: at.toISOString(),
        usableUntil: new Date(at.getTime() + APPROVAL_LIFETIMES.approved).toISOString(),
        approvedDigest: binding.digest,
        challengeHash: undefined,
      } as ApprovalRecord;
    });
    const refused = failure as Failure | null;
    if (refused !== null) {
      throw refusedAfter(refusalFor(done.record)(refused.code, refused.reason, done.record), done);
    }
    return done.record as DisclosureApprovalRecord;
  }

  /** Claims an approved disclosure once, persisting the exact `usedAt` that recovery must subsequently reuse. */
  async claimForDisclosure(approvalId: string, liveBinding: DisclosureBinding): Promise<DisclosureApprovalRecord> {
    let failure: Failure | null = null;
    const done = await this.#transition(approvalId, { kind: 'disclosure' }, 'claim', (current, outcome) => {
      if (outcome.error) throw outcome.error;
      const at = this.#now().toISOString();
      const binding = current.disclosure as DisclosureBinding;
      if (current.state === 'pending') {
        throw new CommsError('APPROVAL_PENDING', 'nothing was disclosed: the standing disclosure approval is pending', {
          details: { approvalId: current.approvalId, state: current.state },
        });
      }
      if (current.state !== 'approved') {
        throw new CommsError(
          'APPROVAL_VOID',
          'nothing was disclosed: the standing disclosure approval was used already',
          {
            details: { approvalId: current.approvalId, state: current.state },
          },
        );
      }
      if (!sameDisclosureBinding(binding, liveBinding) || current.approvedDigest !== binding.digest) {
        failure = { code: 'APPROVAL_VOID', reason: 'the disclosure binding changed after it was approved' };
        return { ...current, state: 'revoked', reason: failure.reason, revokedAt: at, challengeHash: undefined };
      }
      return { ...current, state: 'used', usedAt: at };
    });
    const refused = failure as Failure | null;
    if (refused !== null) throw refusedAfter(refusalFor(done.record)(refused.code, refused.reason, done.record), done);
    await this.#markClaimed(done);
    return done.record as DisclosureApprovalRecord;
  }

  /**
   * A human approved through a confirm channel by typing the issued challenge. The draft must still be exactly what the
   * record was prepared for; otherwise the record is voided, because the human would be approving content the record
   * does not describe. Three wrong answers void it too.
   *
   * A change is approved the same way, with `kind: 'change'` and its digest standing in for the draft (see
   * `createChange`), so a person's typed code means one thing whichever kind of approval it is typed for.
   */
  async approve(
    approvalId: string,
    via: ApprovalChannel,
    live: LiveDraft,
    answer: string,
    kind: ApprovalKind = 'send',
    _platform: NodeJS.Platform = process.platform,
    options: { usedSaid?: UsedSaid | undefined } = {},
  ): Promise<ApprovalRecord> {
    if (kind === 'disclosure') {
      throw new CommsError(
        'APPROVAL_REQUIRED',
        'nothing was disclosed: a standing disclosure approval is only accepted on the trusted terminal or app route',
      );
    }
    let failure: Failure | null = null;
    const done = await this.#transition(
      approvalId,
      { kind },
      'approve',
      (current, outcome) => {
        if (outcome.error) throw outcome.error;
        if (current.state !== 'pending') throw this.#alreadyApproved(current, outcome);
        if (!current.challengeHash)
          throw refusalFor(current)('APPROVAL_REQUIRED', 'no challenge was issued for this approval', current);
        const at = this.#now();
        // A change's confirm means a person at a terminal, and nothing else approves one: a form approval is voided
        // here, before it could be written as approval evidence no change may carry.
        if (kind === 'change' && via !== 'terminal') {
          failure = {
            code: 'APPROVAL_VOID',
            reason: 'the change policy is confirm, and this was not approved at a terminal',
          };
          return { ...current, state: 'revoked', reason: failure.reason, revokedAt: at.toISOString() };
        }
        if (live.draftMessageId !== current.draftMessageId || live.contentDigest !== current.contentDigest) {
          const reason =
            kind === 'change'
              ? 'the change shown is not the one the approval was prepared for'
              : 'the draft changed after the preview was prepared';
          failure = { code: 'APPROVAL_VOID', reason };
          return { ...current, state: 'revoked', reason: failure.reason, revokedAt: at.toISOString() };
        }
        if (!challengeMatches(answer, current.challengeHash)) {
          const attempts = current.challengeAttempts + 1;
          if (attempts >= MAX_CHALLENGE_ATTEMPTS) {
            failure = { code: 'APPROVAL_VOID', reason: 'too many wrong answers to the challenge' };
            return {
              ...current,
              challengeAttempts: attempts,
              state: 'revoked',
              reason: failure.reason,
              revokedAt: at.toISOString(),
            };
          }
          failure = { code: 'APPROVAL_REQUIRED', reason: 'the challenge did not match' };
          return { ...current, challengeAttempts: attempts };
        }
        // Approval starts a window of its own, and records the binding the person approved.
        return {
          ...current,
          state: 'approved',
          approvedVia: via,
          approvedAt: at.toISOString(),
          usableUntil: new Date(at.getTime() + (current.approvedMs ?? APPROVAL_LIFETIMES.approved)).toISOString(),
          approvedBindingDigest: current.bindingDigest,
          challengeHash: undefined,
        };
      },
      { usedSaid: options.usedSaid },
    );
    const failed = failure as Failure | null;
    if (failed) throw refusedAfter(refusalFor(done.record)(failed.code, failed.reason, done.record), done);
    return done.record;
  }

  /**
   * Claims the record for sending, once. Non-consuming refusals (not yet approved) leave the record untouched so the
   * human can still approve it; integrity failures (another account, an edited or changed draft, different recipients
   * or subject) void it. Success creates the O_EXCL claim marker.
   *
   * `live.inboxId` is the owner the caller claims for: a record of another owner is the one `NOT_FOUND`, and left as it
   * is. The policy is the live gate's, from the configuration read under the record's lock (decision 4): a value the
   * caller read before the lock is exactly what a `never` change can land between.
   */
  async claimForSend(
    approvalId: string,
    live: LiveDraft & { inboxId: string; inboxSub?: string | undefined; expect: Expectation },
    options: ClaimOptions = {},
  ): Promise<SendClaim> {
    let failure: Failure | null = null;
    const done = await this.#transition(
      approvalId,
      { kind: 'send', owner: live.inboxId },
      'claim',
      (current, outcome) => {
        // The record's state, its owner and the live policy first: used, expired, voided — or revoked just now, because
        // its owner is gone, its epoch is behind, or sending is turned off — is refused before anything is compared.
        if (outcome.error) throw outcome.error;
        /*
         * Cancelled while the claim waited for the lock: nothing written, the record as it was. Here, before every branch
         * below that writes, and with nothing awaited between this look and the write that changes the record — so no
         * cancellation can land in between.
         */
        if (options.signal?.aborted) throw cancelledClaim(current);
        const at = this.#now().toISOString();
        const voidWith = (code: ErrorCode, reason: string): ApprovalRecord => {
          failure = { code, reason };
          return { ...current, state: 'revoked', reason, revokedAt: at, challengeHash: undefined };
        };
        // Fail closed: an approval prepared against a known account may only be claimed by a caller that names the same
        // account. A caller that passes none is refused rather than trusted, whatever the reason it has none.
        if (current.inboxSub && current.inboxSub !== live.inboxSub) {
          return voidWith(
            'APPROVAL_VOID',
            live.inboxSub
              ? 'the inbox is now connected to a different account'
              : 'the account this was prepared for could not be confirmed',
          );
        }
        if (live.draftMessageId !== current.draftMessageId) {
          return voidWith('APPROVAL_VOID', 'the draft was edited after the preview');
        }
        if (live.contentDigest !== current.contentDigest)
          return voidWith('APPROVAL_VOID', 'the draft content changed after the preview');
        if (!sameExpectation(live.expect, current.expect)) {
          return voidWith('APPROVAL_VOID', 'the recipients or subject given do not match the prepared draft');
        }
        // Waiting for a person: a confirm route, or a chat route the live policy has tightened. Left as it is.
        if (!outcome.claimable) {
          throw refuse(
            'APPROVAL_PENDING',
            'this send needs approval outside the chat first',
            current,
            options.pendingHint ??
              'Ask the user to approve it outside the chat, then try again with the same approval.',
          );
        }
        // The binding the person approved must be the record's own: content, route and identity alike.
        if (current.state === 'approved' && current.approvedBindingDigest !== current.bindingDigest) {
          return voidWith('APPROVAL_VOID', 'the approved content is not the content now in the draft');
        }
        return { ...current, state: 'sending', sendingAt: at };
      },
      { usedSaid: options.usedSaid },
    );
    const failed = failure as Failure | null;
    if (failed) throw refusedAfter(refuse(failed.code, failed.reason, done.record), done);
    const claimToken = randomBytes(16).toString('hex');
    await this.#markClaimed(done, claimToken);
    return { record: done.record, claimToken, approval: done.approval };
  }

  /**
   * The file system's O_EXCL is the single-use guarantee, independent of the lock. A send's marker also holds its
   * claim token, the one thing that lets the claimant — and nobody else — renew its lease and record its outcome.
   */
  async #markClaimed(done: Transitioned, claimToken?: string): Promise<void> {
    const record = done.record;
    await ensurePrivateDir(this.directory);
    try {
      const marker = await open(this.#path(record.approvalId, '.claim'), 'wx', 0o600);
      await marker.writeFile(
        JSON.stringify({
          pid: process.pid,
          at: this.#now().toISOString(),
          ...(claimToken === undefined ? {} : { token: claimToken }),
        }),
      );
      await marker.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw refusedAfter(
          refusalFor(record)('APPROVAL_VOID', 'this approval was already claimed by another process', record),
          done,
        );
      }
      throw error;
    }
  }

  /** Whether `claimToken` is the one in this record's claim marker. A marker without one is held by nobody. */
  async #holdsClaim(approvalId: string, claimToken: string): Promise<boolean> {
    let held: unknown;
    try {
      held = (JSON.parse(await readFile(this.#path(approvalId, '.claim'), 'utf8')) as { token?: unknown }).token;
    } catch {
      return false;
    }
    if (typeof held !== 'string' || typeof claimToken !== 'string' || held.length !== claimToken.length) return false;
    return timingSafeEqual(Buffer.from(held), Buffer.from(claimToken));
  }

  /**
   * Renews the sending lease of a send this call claimed: writes `sendingHeartbeatAt` while the claim still owns a
   * `sending` record, and nothing otherwise. `renewed` while it is sending; `lost` once it reads `unknown` (or anything
   * else) — a renewal never moves a record back to `sending`. Refused, writing nothing, without the claim's token.
   */
  async heartbeat(approvalId: string, claimToken: string): Promise<'renewed' | 'lost'> {
    let renewed = false;
    await this.#transition(
      approvalId,
      { kind: 'send' },
      'inspect',
      (current) => {
        if (current.state !== 'sending') return current;
        renewed = true;
        const now = this.#now();
        // A clock behind the last renewal writes nothing: the lease it gave is still good, and order is kept.
        if (!(now.getTime() > Date.parse(current.sendingHeartbeatAt ?? current.sendingAt ?? ''))) return current;
        return { ...current, sendingHeartbeatAt: now.toISOString() };
      },
      { claimToken },
    );
    return renewed ? 'renewed' : 'lost';
  }

  /**
   * The check before each provider step (design 2026-10-05 §D1): `go`, with the lease renewed, while this claim still
   * owns a `sending` record; `stop` once it reads `unknown` — another caller has decided its outcome cannot be known,
   * and no further step may start. Refused, writing nothing, without the claim's token.
   */
  async fence(approvalId: string, claimToken: string): Promise<'go' | 'stop'> {
    return (await this.heartbeat(approvalId, claimToken)) === 'renewed' ? 'go' : 'stop';
  }

  /**
   * A change approval, pending, bound to `changeDigest(input.change)`.
   *
   * The digest is computed here, never taken from the caller, so a record cannot claim to be bound to one change while
   * describing another. It stands in for the draft revision too, as a reaction's does: a change has no draft, and the
   * same value means the same change.
   */
  async createChange(input: CreateChangeApprovalInput): Promise<ApprovalRecord> {
    requireKnownChannel(input.channel);
    await this.ensurePruned();
    const now = this.#now();
    const change: ChangeBinding = {
      summary: input.change.summary,
      target: input.change.target === null ? null : { ...input.change.target },
      loosened: input.change.loosened.map((loosening) => ({ ...loosening })),
      settings: (input.change.settings ?? []).map((setting) => ({ ...setting })),
      effects: [...input.change.effects],
      ...(input.change.doneAtOnce !== undefined && input.change.doneAtOnce.length > 0
        ? { doneAtOnce: [...input.change.doneAtOnce] }
        : {}),
    };
    const digest = changeDigest(change);
    // What `inboxId` names, from the shape `targetOf` gives a change: nothing, an owner this change creates, or one
    // that exists. Only the last is ever "an owner that was removed".
    const ownerScope: OwnerScope =
      change.target === null ? 'global' : change.target.id === undefined ? 'prospective' : 'owner';
    // The route is the live change policy, fixed now.
    const route: ApprovalRoute = input.policy === 'confirm' ? 'confirm' : 'chat';
    const pendingMs = pendingMsOf(route);
    const record = this.#bound({
      approvalId: newApprovalId(),
      kind: 'change',
      digestVersion: DIGEST_VERSION,
      channel: input.channel,
      ownerScope,
      route,
      pendingMs,
      approvedMs: APPROVAL_LIFETIMES.approved,
      inboxId: change.target?.id ?? '',
      draftId: 'change',
      draftMessageId: digest,
      contentDigest: digest,
      policy: input.policy,
      requiredPolicy: input.policy,
      riskFlags: [],
      // Not an expectation of recipients — a change has none — but it is the field every listing already shows.
      expect: { to: [], cc: [], bcc: [], subject: change.summary },
      challengeAttempts: 0,
      state: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + pendingMs).toISOString(),
      updatedAt: now.toISOString(),
      change,
    });
    await this.#write(record);
    return record;
  }

  /**
   * Claims a change approval, once, for the change the caller is about to write.
   *
   * `live.change` is the change as the caller computes it now, and it has to digest to what was prepared: a different
   * path, a different value, a different account or a different effect voids the approval, because the person agreed
   * to something else. `live.policy` is the change policy in force now, and the stricter of it and the one at prepare
   * decides — so tightening the policy after an agent prepared a change takes effect on that change, and loosening it
   * does not release one prepared under `confirm`.
   *
   * Under `chat` a pending approval is claimable: the yes was given in the conversation. Anything stricter needs a
   * person to have typed the code at a terminal first; until then the refusal leaves the record as it is.
   */
  async claimForChange(approvalId: string, live: LiveChange, options: ClaimOptions = {}): Promise<ApprovalRecord> {
    const digest = changeDigest(live.change);
    let failure: Failure | null = null;
    const done = await this.#transition(approvalId, { kind: 'change' }, 'claim', (current, outcome, gate) => {
      if (outcome.error) throw outcome.error;
      // As for a send: a cancellation that landed while this waited for the lock writes nothing.
      if (options.signal?.aborted) throw cancelledClaim(current);
      const at = this.#now().toISOString();
      const voidWith = (reason: string): ApprovalRecord => {
        failure = { code: 'APPROVAL_VOID', reason };
        return { ...current, state: 'revoked', reason, revokedAt: at };
      };
      if (digest !== current.contentDigest) {
        return voidWith(
          current.change ? changeDrift(current.change, live.change) : 'the change is not the one that was approved',
        );
      }
      // The stricter of the caller's policy and the live gate's, from the configuration read under this lock.
      const governing = stricterPolicy(live.policy, gate?.changePolicy ?? 'confirm');
      if (!outcome.claimable || stricterPolicy(governing, current.requiredPolicy) !== 'chat') {
        if (current.state !== 'approved') {
          throw refuseChange(
            'APPROVAL_PENDING',
            'this change needs a person to approve it at a terminal first',
            current,
            options.pendingHint ?? approvePendingHint(options.handoffs ?? this.#handoffs, approvalId, options.platform),
          );
        }
        // `confirm` means a person at a terminal. An approval given any other way — a form in a client window, which
        // is how a send may be approved — is not what the policy asked for.
        if (current.approvedVia !== 'terminal') {
          return voidWith('the change policy is confirm, and this was not approved at a terminal');
        }
      }
      return { ...current, state: 'used', usedAt: at };
    });
    const failed = failure as Failure | null;
    if (failed) throw refusedAfter(refuseChange(failed.code, failed.reason, done.record), done);
    await this.#markClaimed(done);
    return done.record;
  }

  /**
   * A download's question, pending, bound to `downloadDigest(input.download)` — computed here, never taken from the
   * caller, as a change's digest is. It stands in for the draft revision too.
   *
   * `policy` is the change policy of the mailbox or workspace the files come from, as it stands when the question is
   * asked: where a stranger's files land on this machine is a change to it, and is answered the way that account's
   * other changes are approved. A claim holds the question to the stricter of this and the policy then.
   */
  async createDownload(input: {
    /** The manifest channel the files come from. */
    channel: string;
    download: DownloadBinding;
    policy: ChangePolicy;
  }): Promise<ApprovalRecord & { download: DownloadBinding }> {
    const download: DownloadBinding = {
      summary: input.download.summary,
      target: { ...input.download.target },
      operation: input.download.operation,
      request: JSON.parse(canonicalJson(input.download.request)) as Record<string, unknown>,
      files: [...input.download.files],
      names: [...input.download.names],
      folders: { downloads: input.download.folders.downloads, current: input.download.folders.current },
      ...(input.download.listing === undefined
        ? {}
        : {
            listing: input.download.listing.map((file) => ({
              name: file.name,
              size: file.size,
              ...(file.renamed === undefined ? {} : { renamed: file.renamed }),
              ...(file.flags === undefined || file.flags.length === 0 ? {} : { flags: [...file.flags] }),
            })),
          }),
    };
    // The names a question lists are the names its files are bound to, in order: one that showed other names would be
    // written as a record that reads back corrupt.
    if (
      download.listing !== undefined &&
      canonicalJson(download.listing.map((file) => file.name)) !== canonicalJson(download.names)
    ) {
      throw new CommsError('UNEXPECTED', 'a question’s listing does not name the files it is bound to', {
        hint: 'This is a bug — please report it.',
      });
    }
    requireKnownChannel(input.channel);
    await this.ensurePruned();
    const now = this.#now();
    const digest = downloadDigest(download);
    // Anything but `chat` is `confirm`: a policy word this release does not know is not a reason to ask less.
    const policy: ChangePolicy = input.policy === 'chat' ? 'chat' : 'confirm';
    const record = this.#bound({
      approvalId: newApprovalId(),
      kind: 'download',
      digestVersion: DIGEST_VERSION,
      channel: input.channel,
      ownerScope: 'owner',
      pendingMs: APPROVAL_LIFETIMES.download,
      inboxId: download.target.id,
      draftId: 'download',
      draftMessageId: digest,
      contentDigest: digest,
      policy,
      requiredPolicy: policy,
      riskFlags: [],
      // Not an expectation of recipients, as for a change: the field every listing already shows.
      expect: { to: [], cc: [], bcc: [], subject: download.summary },
      challengeAttempts: 0,
      state: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + APPROVAL_LIFETIMES.download).toISOString(),
      updatedAt: now.toISOString(),
      download,
    });
    await this.#write(record);
    return record as ApprovalRecord & { download: DownloadBinding };
  }

  /**
   * Records the person's answer to a download's question, given where an agent cannot give it: at their own terminal,
   * or in a form a trusted client showed them. The question moves to `approved`, carrying the answer, and waits for
   * the download to claim it — which it may then do under `confirm`, and which saves where this answer says.
   *
   * Only a pending question can be answered, and only once: a second answer is refused, not taken over the first.
   */
  async answerDownload(
    approvalId: string,
    via: ApprovalChannel,
    answer: RecordedSaveAnswer,
    _platform: NodeJS.Platform = process.platform,
  ): Promise<ApprovalRecord & { download: DownloadBinding }> {
    const recorded: RecordedSaveAnswer =
      answer.choice === 'other' ? { choice: 'other', folder: answer.folder } : { choice: answer.choice };
    const done = await this.#transition(approvalId, { kind: 'download' }, 'approve', (current, outcome) => {
      if (outcome.error) throw outcome.error;
      if (current.state === 'approved') {
        throw refuseDownload('APPROVAL_VOID', 'the question was answered already, and it is answered once', current);
      }
      if (!current.download || downloadDigest(current.download) !== current.contentDigest) {
        throw refuseDownload('APPROVAL_VOID', 'the question does not describe the download it is bound to', current);
      }
      // No `approvedAt`: a question is answered, not approved into a window of its own. The answer is bound to it.
      return {
        ...current,
        state: 'approved',
        approvedVia: via,
        approvedDigest: sha256Hex(canonicalJson({ bindingDigest: current.bindingDigest, answer: recorded })),
        download: { ...current.download, answer: recorded },
      };
    });
    return done.record as ApprovalRecord & { download: DownloadBinding };
  }

  /**
   * Claims a download's question, once, for the download the caller is about to make — and returns it, with the
   * folders it offered, so that `downloads` and `current` in the answer mean the paths the person read, and with the
   * answer the person recorded, when they recorded one.
   *
   * `live` is the download as the caller computes it now: the same account, the same request, the same files under
   * the same names — the person answered for those files and no others. Any other is refused, and the question left
   * open, as it was: a second call that got an argument wrong is the agent's slip, not the person's, and voiding the
   * question for it would make the person answer again for nothing. It still expires, and is claimed once.
   *
   * Whether it can be claimed is the download `claimable` matrix (`downloadClaimable`, design 2026-10-05 §D2), decided
   * under the question's lock against the live change policy read there — never a policy the caller read before it.
   * While both the policy the question was asked under and the live one are `chat`, a pending question is claimed
   * with the answer the caller carries: the person gave it in the conversation, and it is never kept. Otherwise only a
   * question the person answered at a terminal or in a trusted form can be claimed; a pending one is refused, and left
   * as it is, so they can still answer it. One used, voided, expired or corrupt is refused for what it is.
   *
   * `options.signal` is the download's cancellation, asked under the lock as a send's is (`ClaimOptions.signal`): a
   * download cancelled while this waited saves nothing and leaves the question open, the answer still unused.
   */
  async claimForDownload(
    approvalId: string,
    live: DownloadRequest,
    options: {
      pendingHint?: string | undefined;
      signal?: AbortSignal | undefined;
      platform?: NodeJS.Platform | undefined;
      handoffs?: CliHandoffs | undefined;
    } = {},
  ): Promise<ApprovalRecord & { download: DownloadBinding }> {
    const digest = downloadDigest(live);
    let failure: Failure | null = null;
    const done = await this.#transition(approvalId, { kind: 'download' }, 'claim', (current, outcome) => {
      if (outcome.error) throw outcome.error;
      if (options.signal?.aborted) throw cancelledClaim(current);
      const at = this.#now().toISOString();
      const voidWith = (reason: string): ApprovalRecord => {
        failure = { code: 'APPROVAL_VOID', reason };
        return { ...current, state: 'revoked', reason, revokedAt: at };
      };
      // What the record says it asked about has to be what its digest binds, or it describes nothing at all.
      if (!current.download || downloadDigest(current.download) !== current.contentDigest) {
        return voidWith('the question does not describe the download it is bound to');
      }
      if (digest !== current.contentDigest) {
        throw refuseDownload(
          'USAGE',
          `${downloadDrift(current.download, live)}; the question is still open`,
          current,
          'Call again with the same arguments the question was asked with, and its choice id. If the files themselves changed, make the download again without an answer, and show the person the new question.',
        );
      }
      // The matrix, as the classification under this lock decided it: anything it does not call claimable here is a
      // question still waiting for the person — every other state was refused above, for what it is.
      if (!outcome.claimable) throw downloadPendingRefusal(current, options.pendingHint);
      return { ...current, state: 'used', usedAt: at };
    });
    const failed = failure as Failure | null;
    if (failed) throw refusedAfter(refuseDownload(failed.code, failed.reason, done.record), done);
    await this.#markClaimed(done);
    return done.record as ApprovalRecord & { download: DownloadBinding };
  }

  /**
   * Records the outcome of the one send attempt: `used` with the provider's id for it, when the provider accepted it,
   * or `failed`.
   *
   * `used` needs a non-empty id. A provider that accepted a send without one has not given anything to record it by,
   * so the record is left as it is — `sending`, and then `unknown` — rather than made `used` with an empty id that
   * every later reader would take for one.
   *
   * Only the claimant records it, by its claim token, from `sending` or from `unknown`: a provider's answer that
   * arrives after the lease ran out is still the truth. A late success clears the stale-lease reason; a late failure
   * replaces it with its own.
   */
  async complete(approvalId: string, claimToken: string, outcome: SendOutcome): Promise<ApprovalRecord> {
    if ('sentMessageId' in outcome && outcome.sentMessageId === '') {
      throw new CommsError('BAD_DATA', 'the provider returned no id for the send, so it is not recorded as used', {
        hint: 'The send may have happened: check before sending again.',
        details: { approvalId },
      });
    }
    const done = await this.#transition(
      approvalId,
      { kind: 'send' },
      'claim',
      (current, classified) => {
        if (current.state !== 'sending' && current.state !== 'unknown') {
          throw (
            classified.error ??
            refuse('APPROVAL_VOID', 'the approval is not being sent, so it has no outcome to record', current)
          );
        }
        // Never before the claim or its last renewal, whatever the clock says: the record stays in order.
        const floor = Date.parse(current.sendingHeartbeatAt ?? current.sendingAt ?? '');
        const now = this.#now().getTime();
        const at = new Date(Number.isFinite(floor) ? Math.max(now, floor) : now).toISOString();
        // `usedAt` is the moment the provider accepted it, and so equal to `sentAt`.
        return 'sentMessageId' in outcome
          ? {
              ...current,
              state: 'used',
              sentMessageId: outcome.sentMessageId,
              sentAt: at,
              usedAt: at,
              reason: undefined,
            }
          : { ...current, state: 'failed', reason: outcome.error, failedAt: at };
      },
      { claimToken },
    );
    return done.record;
  }

  /**
   * Voids a pending or approved record. Other records are left as they are, and returned as they read.
   *
   * `disposition` says whose decision this is, and has no default: every caller chooses (`RevokeDisposition`). A
   * version-1 record is retired in its own shape when a person or an owner's removal revokes it (`revokeLegacy`), and
   * refused with the version refusal, nothing written, when this release's integrity check would have voided it. A
   * corrupt or unreadable record is never revoked or rewritten: it is refused with the integrity refusal, which repeats
   * only its stub.
   */
  async revoke(
    approvalId: string,
    reason: string,
    options: { disposition: RevokeDisposition; expect?: ApprovalExpectation | undefined },
  ): Promise<StoredApproval> {
    const expect = options.expect ?? {};
    const config = await this.#config();
    const found = await this.#read(approvalId, config);
    if (found === null || !matchesExpectation(found, expect)) throw approvalNotFound(approvalId, expect.kind);
    if (found.form === 'legacy') {
      if (options.disposition === 'integrity') throw otherVersionRefusal(found.view);
      const retired = await this.revokeLegacy(approvalId, reason);
      return { form: 'legacy', view: decodeLegacyV1(retired, config, this.#now()), record: retired };
    }
    if (found.form !== 'v2') throw integrityRefusal(found);
    const { record } = await this.#transition(approvalId, expect, 'revoke', (current) =>
      current.state === 'pending' || current.state === 'approved'
        ? { ...current, state: 'revoked', reason, revokedAt: this.#now().toISOString(), challengeHash: undefined }
        : current,
    );
    return { form: 'v2', record };
  }

  /**
   * Retires a record from an earlier release (version 1) in that release's own shape, so a process still running it
   * can no longer claim the record — and nothing more.
   *
   * Under the record's own lock, `<id>.json.lock`, the one 0.13.0's transitions take, so the two serialise. The file
   * is read again there, decoded, and its state derived by its own release's rules (`deriveLegacyV1State`). Only a
   * `pending` or `approved` record is rewritten, as itself plus `state: 'revoked'`, the reason and `updatedAt`: its
   * digest version stays 1, a send stays without a `kind`, and no field of this release's is added — no claim marker
   * either. Any other derived state is returned as it reads and written nothing: an expired record is never rewritten,
   * as `revoke` leaves every finished record as it is.
   *
   * It reads no configuration and needs no owner, so it works on a record whose account is already gone. Its only
   * callers are a person's revoke, the removal of the record's owner, and the legacy drain.
   */
  async revokeLegacy(approvalId: string, reason: string): Promise<LegacyApprovalRecord> {
    const path = this.#path(approvalId);
    return withFileLock(`${path}.lock`, async () => {
      const found = await this.#read(approvalId, null);
      if (!found) throw refuse('NOT_FOUND', `no approval ${approvalId}`);
      if (found.form === 'corrupt' || found.form === 'unreadable') throw integrityRefusal(found);
      if (found.form !== 'legacy') {
        throw refusalFor(found.record)(
          'APPROVAL_VOID',
          'the approval is not one an earlier release prepared, so it is not retired as one',
          found.record,
        );
      }
      const raw = found.record;
      const derived = this.#deriveLegacy(raw);
      if (derived.state !== 'pending' && derived.state !== 'approved') return derived;
      const revoked: LegacyApprovalRecord = { ...raw, state: 'revoked', reason, updatedAt: this.#now().toISOString() };
      await this.#write(revoked);
      return revoked;
    });
  }

  /**
   * Every approval file, each looked at under its own lock and classified there, as `inspect` looks at one — against one
   * configuration snapshot, loaded once before any file is read (design 2026-10-05 §D2, §D8). What a list shows: each
   * record's form and its outcome, nothing skipped. Like a look, it writes only what reading derives — an expiry at its
   * boundary, a stale send's `unknown` — never a revocation: an owner removed or a stale epoch is shown as revoked, and
   * written by the next action.
   *
   * `inboxId` keeps the records whose owner is that id (`ownerOf`), so one whose owner cannot be trusted never matches;
   * `states` keeps those whose classified state is listed — a stored state, `corrupt`, and for a download's answered
   * question its stored `approved` or `used`.
   */
  async inspectAll(
    filter: { inboxId?: string; states?: (ApprovalState | 'corrupt')[] } = {},
  ): Promise<Array<{ stored: StoredApproval; outcome: ApprovalOutcome }>> {
    // The day's retention first, bounded: the list goes on whatever it finds (design 2026-10-05 §D9).
    await this.ensurePruned();
    let names: string[];
    try {
      names = (await readdir(this.directory)).filter((name) => APPROVAL_ID_PATTERN.test(name.replace(/\.json$/, '')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const config = await this.#config();
    const found: Array<{ stored: StoredApproval; outcome: ApprovalOutcome }> = [];
    for (const name of names) {
      const approvalId = name.slice(0, -5);
      const seen = await withFileLock(`${this.#path(approvalId)}.lock`, async () => {
        const read = await this.#read(approvalId, config);
        // Gone between the listing and the read: there is nothing to show.
        if (read === null) return null;
        const derived = this.#derived(read);
        if (read.form === 'v2' && derived.form === 'v2' && derived.record.state !== read.record.state) {
          await this.#write({ ...derived.record, updatedAt: this.#now().toISOString() });
        }
        const live = config === null || derived.form !== 'v2' ? null : liveGateOf(config, derived.record);
        return { stored: derived, outcome: approvalOutcome(derived, { action: 'inspect', live, now: this.#now() }) };
      });
      if (seen === null) continue;
      if (filter.inboxId !== undefined && filter.inboxId !== '' && ownerOf(seen.stored) !== filter.inboxId) continue;
      const shown = seen.outcome.state === 'answered' ? stateOf(seen.stored) : seen.outcome.state;
      if (filter.states && !filter.states.includes(shown)) continue;
      found.push(seen);
    }
    return found.sort((a, b) => byCreation(a.stored, b.stored));
  }

  /**
   * Every approval file, each in one of its four forms — nothing skipped, nothing omitted — read against one
   * configuration snapshot, loaded once before any file is read: a loader that fails fails the whole list.
   *
   * `inboxId` keeps the records whose owner is that id (`ownerOf`), so a file whose owner cannot be trusted never
   * matches one; `states` keeps those whose state (`stateOf`, `corrupt` for one that cannot be used) is listed.
   */
  async list(filter: { inboxId?: string; states?: (ApprovalState | 'corrupt')[] } = {}): Promise<StoredApproval[]> {
    let names: string[];
    try {
      // The same pattern the store validates an id against, so a file this listing shows is a file it can open.
      // A looser one here silently skipped records whose names it had itself accepted as plausible.
      names = (await readdir(this.directory)).filter((name) => APPROVAL_ID_PATTERN.test(name.replace(/\.json$/, '')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const config = await this.#config();
    const found: StoredApproval[] = [];
    for (const name of names) {
      // Gone between the listing and the read: there is nothing to show.
      const stored = await this.#read(name.slice(0, -5), config);
      if (stored === null) continue;
      const current = this.#derived(stored);
      if (filter.inboxId !== undefined && filter.inboxId !== '' && ownerOf(current) !== filter.inboxId) continue;
      if (filter.states && !filter.states.includes(stateOf(current))) continue;
      found.push(current);
    }
    return found.sort(byCreation);
  }
}

/** Oldest first; a record that cannot be read has no time to be ordered by, and follows, by id. */
function byCreation(a: StoredApproval, b: StoredApproval): number {
  const createdOf = (stored: StoredApproval) =>
    stored.form === 'v2' ? stored.record.createdAt : stored.form === 'legacy' ? stored.view.createdAt : null;
  const idOf = (stored: StoredApproval) =>
    stored.form === 'v2'
      ? stored.record.approvalId
      : stored.form === 'legacy'
        ? stored.view.approvalId
        : (corruptStubOf(stored)?.approvalId ?? '');
  const [x, y] = [createdOf(a), createdOf(b)];
  if (x !== null && y !== null) return x < y ? -1 : x > y ? 1 : 0;
  if (x !== null) return -1;
  if (y !== null) return 1;
  return idOf(a) < idOf(b) ? -1 : 1;
}

/**
 * Compares recipient lists by address alone. A provider may return `Name <addr>` where the caller gave `addr`, and
 * a difference in display name is not a difference in who receives the mail — while a spurious mismatch voids an
 * approval the user already gave, and sends them round the loop again.
 */
/**
 * The address inside an entry, read the same way every other part of this package reads it.
 *
 * This took the **first** `<…>` while `normaliseAddress` takes the **last**, so
 * `"<attacker@evil.test> Sam <sam@partner.test>"` satisfied an expectation check against one address while every
 * other reader saw the other. Two parsers for one idea is how a check ends up guarding something different from
 * what it appears to guard.
 */
function bareAddress(entry: string): string {
  return normaliseAddress(entry);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  const norm = (list: readonly string[]) => [...new Set(list.map(bareAddress))].sort().join('\n');
  return norm(a) === norm(b);
}

export function sameExpectation(a: Expectation, b: Expectation): boolean {
  return (
    sameList(a.to, b.to) && sameList(a.cc, b.cc) && sameList(a.bcc, b.bcc) && a.subject.trim() === b.subject.trim()
  );
}
