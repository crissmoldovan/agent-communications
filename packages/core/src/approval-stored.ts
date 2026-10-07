import type { OwnerScope } from './approval-binding.ts';
import {
  decodeLegacyV1,
  LEGACY_DIGEST_VERSION,
  type LegacyApprovalRecord,
  type LegacyView,
} from './approval-legacy.ts';
import { type Attribution, type IntegrityReason, validateV2 } from './approval-validate.ts';
import type { ApprovalKind, ApprovalRecord, ApprovalState, Expectation } from './approvals.ts';
import type { Config } from './config.ts';
import { CommsError } from './errors.ts';

/**
 * Every approval file, read one way (design 2026-10-05 §D2, "Legacy version-1 records, one decoder everywhere" and
 * "Two classes of parseable corrupt record").
 *
 * A file is one of four things, and every read says which:
 *
 * - `v2` — a version-2 record that passed `validateV2`: the only form anything may act on;
 * - `legacy` — a structurally valid version-1 record, read by its own release's rules: reported, never claimed;
 * - `corrupt` — a parseable version-2 record that failed its integrity check, attributable to its owner or not;
 * - `unreadable` — a file that cannot safely be read at all: shown only as a stub naming its id (from the file name)
 *   and a fixed reason, never anything the file holds.
 *
 * Nothing is silently omitted, and the decoder writes nothing.
 */

/** Why a file cannot safely be read: a fixed category, never the file's own bytes. */
export type UnreadableReason =
  | 'invalid-json'
  | 'truncated'
  | 'missing-ownership'
  | 'missing-kind'
  | 'wrong-shape'
  | 'file-name-mismatch';

/** What may be said of a record that cannot be trusted: its id, that it is corrupt, and why — nothing else. */
export interface CorruptStub {
  readonly approvalId: string;
  readonly state: 'corrupt';
  readonly reason: UnreadableReason | IntegrityReason;
}

/** What an attribution-verified corrupt record may still show its owner: the fields its binding was made over. */
export interface OrdinarySafeFields {
  readonly kind: ApprovalKind;
  readonly channel: string;
  readonly ownerScope: OwnerScope;
  readonly inboxId: string;
  readonly inboxSub?: string | undefined;
  readonly draftId: string;
  readonly draftMessageId: string;
  readonly expect: Expectation;
}

/** A disclosure record has no channel owner or sender-controlled operational fields to expose. */
export interface DisclosureSafeFields {
  readonly kind: 'disclosure';
}

export type SafeFields = OrdinarySafeFields | DisclosureSafeFields;

export type StoredApproval =
  | { readonly form: 'v2'; readonly record: ApprovalRecord }
  | { readonly form: 'legacy'; readonly view: LegacyView; readonly record: LegacyApprovalRecord }
  | {
      readonly form: 'corrupt';
      readonly approvalId: string;
      readonly reason: IntegrityReason;
      readonly attribution: Attribution;
      /** Only when attribution is verified. */
      readonly safe: SafeFields | null;
    }
  | { readonly form: 'unreadable'; readonly stub: CorruptStub };

// ── Decoding ─────────────────────────────────────────────────────────────────────────────────────────────────────

const STATES: readonly string[] = ['pending', 'approved', 'sending', 'used', 'failed', 'unknown', 'expired', 'revoked'];
const KINDS: readonly string[] = ['send', 'change', 'download', 'disclosure'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);

function unreadable(approvalId: string, reason: UnreadableReason): StoredApproval {
  return { form: 'unreadable', stub: { approvalId, state: 'corrupt', reason } };
}

function expectationShaped(value: unknown): boolean {
  return (
    isObject(value) && isStrings(value.to) && isStrings(value.cc) && isStrings(value.bcc) && isString(value.subject)
  );
}

/**
 * The types every record shares, version 1 or 2: anything of the wrong type cannot reach the classifier. Values —
 * a timestamp that is a string but not a time, a digest that is a string but not hex — are the validator's.
 */
function commonShape(raw: Record<string, unknown>): UnreadableReason | null {
  if (!isString(raw.inboxId)) return 'missing-ownership';
  if (!isString(raw.state) || !STATES.includes(raw.state)) return 'wrong-shape';
  for (const field of ['createdAt', 'expiresAt', 'updatedAt', 'draftId', 'draftMessageId'] as const) {
    if (!isString(raw[field])) return 'wrong-shape';
  }
  if (!expectationShaped(raw.expect)) return 'wrong-shape';
  for (const field of [
    'inboxSub',
    'approvedVia',
    'approvedDigest',
    'challengeHash',
    'sentMessageId',
    'reason',
    'policy',
    'requiredPolicy',
  ] as const) {
    if (!optional(raw[field], isString)) return 'wrong-shape';
  }
  if (!optional(raw.riskFlags, isStrings)) return 'wrong-shape';
  if (!optional(raw.challengeAttempts, (value) => typeof value === 'number')) return 'wrong-shape';
  const kind = raw.kind ?? 'send';
  if (kind === 'change') {
    const change = raw.change;
    if (
      !isObject(change) ||
      !isString(change.summary) ||
      !(change.target === null || isObject(change.target)) ||
      !Array.isArray(change.loosened) ||
      !isStrings(change.effects)
    ) {
      return 'wrong-shape';
    }
  }
  if (kind === 'download') {
    const download = raw.download;
    if (
      !isObject(download) ||
      !isString(download.summary) ||
      !isObject(download.target) ||
      !isString(download.target.id) ||
      !isStrings(download.files) ||
      !isStrings(download.names) ||
      !isObject(download.folders) ||
      !isString(download.folders.downloads) ||
      !isString(download.folders.current) ||
      !optional(download.listing, (listing) => Array.isArray(listing) && listing.every((file) => isObject(file)))
    ) {
      return 'wrong-shape';
    }
  }
  return null;
}

/** The disclosure union member is deliberately closed: it cannot acquire a send-shaped field by optionality. */
function disclosureShape(raw: Record<string, unknown>): UnreadableReason | null {
  for (const field of ['approvalId', 'state', 'createdAt', 'expiresAt', 'updatedAt', 'bindingDigest'] as const) {
    if (!isString(raw[field])) return 'wrong-shape';
  }
  for (const field of ['pendingMs', 'approvedMs', 'challengeAttempts'] as const) {
    if (typeof raw[field] !== 'number') return 'wrong-shape';
  }
  for (const field of [
    'approvedDigest',
    'approvedVia',
    'approvedAt',
    'usableUntil',
    'challengeHash',
    'usedAt',
    'revokedAt',
    'expiredAt',
    'reason',
  ] as const) {
    if (!optional(raw[field], isString)) return 'wrong-shape';
  }
  const disclosure = raw.disclosure;
  if (
    !isObject(disclosure) ||
    !isString(disclosure.digest) ||
    !isString(disclosure.activationIntentId) ||
    !isString(disclosure.activationKind) ||
    !Array.isArray(disclosure.versions) ||
    !disclosure.versions.every(
      (entry) => isObject(entry) && isString(entry.kind) && isString(entry.id) && typeof entry.version === 'number',
    )
  ) {
    return 'wrong-shape';
  }
  for (const field of [
    'channel',
    'ownerScope',
    'route',
    'inboxId',
    'inboxSub',
    'draftId',
    'draftMessageId',
    'expect',
    'sendEpoch',
    'policy',
    'requiredPolicy',
    'riskFlags',
    'approvedBindingDigest',
    'sendingAt',
    'sendingHeartbeatAt',
    'sentAt',
    'sentMessageId',
    'failedAt',
    'change',
    'download',
    'contentDigest',
  ] as const) {
    if (Object.hasOwn(raw, field)) return 'wrong-shape';
  }
  return null;
}

/** The version-2 fields' types: a number where a number belongs, a string where a string does. */
function v2Shape(raw: Record<string, unknown>): UnreadableReason | null {
  for (const field of ['channel', 'ownerScope', 'contentDigest'] as const) {
    if (!optional(raw[field], isString)) return 'wrong-shape';
  }
  for (const field of ['pendingMs', 'approvedMs', 'sendEpoch'] as const) {
    if (!optional(raw[field], (value) => typeof value === 'number')) return 'wrong-shape';
  }
  for (const field of [
    'route',
    'bindingDigest',
    'approvedBindingDigest',
    'approvedAt',
    'usableUntil',
    'sendingAt',
    'sendingHeartbeatAt',
    'usedAt',
    'sentAt',
    'failedAt',
    'revokedAt',
    'expiredAt',
  ] as const) {
    if (!optional(raw[field], isString)) return 'wrong-shape';
  }
  return null;
}

/**
 * Decodes one approval file, read as `fileId` — its name — against `config` (for a version-1 record's attribution only;
 * `null` when there is none to read). Writes nothing. `now` is when it is read, for a version-1 record's derived state.
 */
export function decodeStored(fileId: string, text: string, config: Config | null, now: Date): StoredApproval {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const trimmed = text.trim();
    return unreadable(
      fileId,
      trimmed === '' || (trimmed.startsWith('{') && !trimmed.endsWith('}')) ? 'truncated' : 'invalid-json',
    );
  }
  if (!isObject(raw)) return unreadable(fileId, 'wrong-shape');
  if (!isString(raw.approvalId)) return unreadable(fileId, 'wrong-shape');
  if (raw.kind === 'disclosure') {
    if (raw.digestVersion === LEGACY_DIGEST_VERSION) return unreadable(fileId, 'wrong-shape');
    const shape = disclosureShape(raw);
    if (shape !== null) return unreadable(fileId, shape);
    const record = raw as unknown as ApprovalRecord;
    const validation = validateV2(record, fileId);
    if (validation.ok) return { form: 'v2', record };
    return {
      form: 'corrupt',
      approvalId: fileId,
      reason: validation.reason,
      attribution: validation.attribution,
      safe: validation.attribution === 'verified' ? safeFieldsOf(record) : null,
    };
  }
  const shape = commonShape(raw);
  if (shape !== null) return unreadable(fileId, shape);

  if (raw.digestVersion === LEGACY_DIGEST_VERSION) {
    // Version 1: an absent kind is a send, as 0.13.0 wrote it; any other kind it did not write is no record of its.
    if (!optional(raw.kind, (kind) => isString(kind) && KINDS.includes(kind))) return unreadable(fileId, 'wrong-shape');
    if (!isString(raw.digest)) return unreadable(fileId, 'wrong-shape');
    if (raw.approvalId !== fileId) return unreadable(fileId, 'file-name-mismatch');
    const record = raw as unknown as LegacyApprovalRecord;
    return { form: 'legacy', view: decodeLegacyV1(record, config, now), record };
  }

  // Version 2, or a version nobody here wrote: ownership and kind are explicit, a send's included.
  if (!isString(raw.kind) || !KINDS.includes(raw.kind)) return unreadable(fileId, 'missing-kind');
  const v2 = v2Shape(raw);
  if (v2 !== null) return unreadable(fileId, v2);
  const record = raw as unknown as ApprovalRecord;
  const validation = validateV2(record, fileId);
  if (validation.ok) return { form: 'v2', record };
  return {
    form: 'corrupt',
    // Never the stored id: a record in another's file is read as the file it is in.
    approvalId: fileId,
    reason: validation.reason,
    attribution: validation.attribution,
    safe: validation.attribution === 'verified' ? safeFieldsOf(record) : null,
  };
}

function safeFieldsOf(record: ApprovalRecord): SafeFields {
  if (record.kind === 'disclosure') return { kind: 'disclosure' };
  return {
    kind: record.kind,
    channel: record.channel,
    ownerScope: record.ownerScope,
    inboxId: record.inboxId,
    ...(record.inboxSub === undefined ? {} : { inboxSub: record.inboxSub }),
    draftId: record.draftId,
    draftMessageId: record.draftMessageId,
    expect: record.expect,
  };
}

// ── Narrowing ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The valid version-2 record, or null for every other form: the only one anything may act on. */
export function asV2(stored: StoredApproval | null): ApprovalRecord | null {
  return stored?.form === 'v2' ? stored.record : null;
}

/** The version-1 record as stored, for the guards and checks that read its own fields; null for every other form. */
export function asLegacy(stored: StoredApproval | null): LegacyApprovalRecord | null {
  return stored?.form === 'legacy' ? stored.record : null;
}

/**
 * Whose a record is — its stored `inboxId` (`''` for a change to no owner) — or null when that cannot be trusted: an
 * unreadable file, or a corrupt record whose binding does not verify. A version-1 record's stored owner is trusted, the
 * stated limit of a record with no binding.
 */
export function ownerOf(stored: StoredApproval | null): string | null {
  if (stored === null) return null;
  switch (stored.form) {
    case 'v2':
      return stored.record.kind === 'disclosure' ? null : stored.record.inboxId;
    case 'legacy':
      return stored.record.inboxId;
    case 'corrupt':
      return stored.safe?.kind === 'disclosure' ? null : (stored.safe?.inboxId ?? null);
    case 'unreadable':
      return null;
  }
}

/** What a record permits, from the same trusted sources as `ownerOf`; null when it cannot be known. */
export function kindOf(stored: StoredApproval | null): ApprovalKind | null {
  if (stored === null) return null;
  switch (stored.form) {
    case 'v2':
      return stored.record.kind;
    case 'legacy':
      return stored.view.kind;
    case 'corrupt':
      return stored.safe?.kind ?? null;
    case 'unreadable':
      return null;
  }
}

/**
 * Which channel a record is — the manifest channel that prepared it — from the same trusted sources as `ownerOf`; null
 * when that cannot be known: an unreadable file, a corrupt record whose binding does not verify, or an earlier
 * release's record whose owner no channel can be told from (an `acc_` owner whose account is gone).
 */
export function channelOf(stored: StoredApproval | null): string | null {
  if (stored === null) return null;
  switch (stored.form) {
    case 'v2':
      return stored.record.kind === 'disclosure' ? null : stored.record.channel;
    case 'legacy':
      return stored.view.channel;
    case 'corrupt':
      return stored.safe?.kind === 'disclosure' ? null : (stored.safe?.channel ?? null);
    case 'unreadable':
      return null;
  }
}

/** The stored or derived state, or `corrupt`. */
export function stateOf(stored: StoredApproval): ApprovalState | 'corrupt' {
  switch (stored.form) {
    case 'v2':
      return stored.record.state;
    case 'legacy':
      return stored.view.state;
    default:
      return 'corrupt';
  }
}

/** The stub of a record that cannot be used — `{ approvalId, state: 'corrupt', reason }` — or null. */
export function corruptStubOf(stored: StoredApproval): CorruptStub | null {
  switch (stored.form) {
    case 'corrupt':
      return { approvalId: stored.approvalId, state: 'corrupt', reason: stored.reason };
    case 'unreadable':
      return stored.stub;
    default:
      return null;
  }
}

/**
 * The refusal of an action on a record that cannot be used: corrupt, or unreadable. It repeats only the stub, as
 * `details.approval`, and is given where no pin applies; a pinned surface says `NOT_FOUND` instead (N1), because it
 * cannot tell whose the record is.
 */
export function integrityRefusal(stored: StoredApproval): CommsError {
  const stub = corruptStubOf(stored);
  if (stub === null)
    throw new CommsError('UNEXPECTED', 'an integrity refusal was asked for a record that is not corrupt');
  const what =
    stored.form === 'unreadable'
      ? `approval ${stub.approvalId} could not be read (${stub.reason})`
      : `approval ${stub.approvalId} is corrupt (${stub.reason})`;
  return new CommsError('APPROVAL_VOID', `nothing was done: ${what}`, {
    hint: 'It is never used, and nothing in it is shown. Prepare it again if it is still wanted.',
    details: { approvalId: stub.approvalId, approval: stub },
  });
}
