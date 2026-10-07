import {
  APPROVAL_LIFETIMES,
  bindingDigestOf,
  canonicalDisclosureBinding,
  type DisclosureBinding,
  isKnownChannel,
  pendingMsOf,
} from './approval-binding.ts';
import { type ApprovalRecord, type ApprovalState, changeDigest, DIGEST_VERSION, downloadDigest } from './approvals.ts';
import { canonicalJson, sha256Hex } from './digest.ts';

/**
 * The integrity check of a version-2 approval record (design 2026-10-05 §D1, "Digest integrity" and "Version-2
 * timestamps fail closed"). Pure: it reads the record and the id its file is named by, and decides.
 *
 * A record either passes, or is `corrupt` for one fixed reason — never a sentence built from the record, so nothing a
 * file holds is ever echoed — and of one of two attribution classes. `verified`: its `bindingDigest` recomputes, so its
 * owner and identity can be trusted and it is corrupt for another reason (a state, a timestamp, its evidence).
 * `unverifiable`: its binding is missing, malformed or does not match, or it sits in another record's file, so nothing
 * it says about whom it belongs to can be trusted.
 *
 * Nothing here is wired into a read yet; the store's decoder does that.
 */

/** Why a version-2 record is corrupt: a fixed category, never the record's own words. */
export type IntegrityReason =
  | 'file-name-mismatch'
  | 'binding-missing'
  | 'binding-malformed'
  | 'binding-mismatch'
  | 'wrong-shape'
  | 'digest-version'
  | 'content-digest-malformed'
  | 'content-digest-mismatch'
  | 'identity-contradiction'
  | 'listing-mismatch'
  | 'state-impossible'
  | 'lifetime-mismatch'
  | 'timestamp-invalid'
  | 'timestamp-missing'
  | 'timestamp-misplaced'
  | 'timestamp-misordered'
  | 'sent-id-missing'
  | 'evidence-missing'
  | 'evidence-invalid'
  | 'evidence-contradictory';

export type Attribution = 'verified' | 'unverifiable';

export type Validation = { ok: true } | { ok: false; reason: IntegrityReason; attribution: Attribution };

/** The one ordering exemption: an expiry forced because the clock was seen before the record's own times. */
export const CLOCK_ANOMALY = 'clock-anomaly';

const HEX64 = /^[0-9a-f]{64}$/;
/** Exactly what `Date.prototype.toISOString` writes, which is all the store ever writes. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STATES: readonly ApprovalState[] = [
  'pending',
  'approved',
  'sending',
  'used',
  'failed',
  'unknown',
  'expired',
  'revoked',
];
/** The states each kind can reach. A change or a download is claimed straight to `used`: it is never sent. */
const STATES_OF: Readonly<Record<'send' | 'change' | 'download', readonly ApprovalState[]>> = {
  send: STATES,
  change: ['pending', 'approved', 'used', 'expired', 'revoked'],
  download: ['pending', 'approved', 'used', 'expired', 'revoked'],
};
/** The send states that went through a claim, and so carry `sendingAt`. */
const CLAIMED_SEND: readonly ApprovalState[] = ['sending', 'used', 'failed', 'unknown'];

type Fail = { ok: false; reason: IntegrityReason; attribution: Attribution };

/** A record's timestamp field: absent, invalid, or the time it names. */
function timeOf(value: unknown): number | null | 'invalid' {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !ISO.test(value)) return 'invalid';
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value ? at : 'invalid';
}

const TIMESTAMPS = [
  'createdAt',
  'expiresAt',
  'approvedAt',
  'usableUntil',
  'sendingAt',
  'sendingHeartbeatAt',
  'usedAt',
  'sentAt',
  'failedAt',
  'revokedAt',
  'expiredAt',
] as const;
type Stamp = (typeof TIMESTAMPS)[number];

/**
 * Whether `record`, read from the file named `fileId`, is a valid version-2 record — and if not, why, and whether its
 * owner can still be trusted.
 */
export function validateV2(record: ApprovalRecord, fileId: string): Validation {
  const raw = record as unknown as Record<string, unknown>;
  // Another record's file: nothing it says, its owner included, is about the id it is read as.
  if (raw.approvalId !== fileId) return fail('file-name-mismatch', 'unverifiable');
  const binding = raw.bindingDigest;
  if (binding === undefined) return fail('binding-missing', 'unverifiable');
  if (typeof binding !== 'string' || !HEX64.test(binding)) return fail('binding-malformed', 'unverifiable');
  let recomputed: string;
  try {
    recomputed = bindingDigestOf(record);
  } catch {
    return fail('wrong-shape', 'unverifiable');
  }
  if (recomputed !== binding) return fail('binding-mismatch', 'unverifiable');
  // From here on the owner and identity are those the binding was made over: whatever else is wrong, the record can
  // be shown to its owner as corrupt.
  return checkVerified(record, raw) ?? { ok: true };
}

function fail(reason: IntegrityReason, attribution: Attribution = 'verified'): Fail {
  return { ok: false, reason, attribution };
}

function checkVerified(record: ApprovalRecord, raw: Record<string, unknown>): Fail | null {
  if (raw.digestVersion !== DIGEST_VERSION) return fail('digest-version');
  const kind = raw.kind;
  if (kind === 'disclosure') return checkDisclosure(record, raw);
  if (kind !== 'send' && kind !== 'change' && kind !== 'download') return fail('wrong-shape');
  if (!STATES.includes(raw.state as ApprovalState)) return fail('state-impossible');
  const state = raw.state as ApprovalState;

  // Digests: both lowercase hex; a change's and a download's content recomputes from what the record stores.
  if (typeof raw.contentDigest !== 'string' || !HEX64.test(raw.contentDigest)) return fail('content-digest-malformed');
  if (kind === 'change') {
    if (record.change === undefined || changeDigest(record.change) !== record.contentDigest) {
      return fail('content-digest-mismatch');
    }
  }
  if (kind === 'download') {
    if (record.download === undefined || downloadDigest(record.download) !== record.contentDigest) {
      return fail('content-digest-mismatch');
    }
  }

  const identity = checkIdentity(record, raw, kind);
  if (identity !== null) return identity;
  if (!STATES_OF[kind].includes(state)) return fail('state-impossible');

  const lifetime = checkLifetime(raw, kind);
  if (lifetime !== null) return lifetime;

  const times: Partial<Record<Stamp, number>> = {};
  for (const field of TIMESTAMPS) {
    const at = timeOf(raw[field]);
    if (at === 'invalid') return fail('timestamp-invalid');
    if (at !== null) times[field] = at;
  }
  return checkTimestamps(raw, kind, state, times) ?? checkEvidence(record, raw, kind, state);
}

/** Validates the closed disclosure union member without borrowing a sender approval's shape. */
function checkDisclosure(record: ApprovalRecord, raw: Record<string, unknown>): Fail | null {
  if (!['pending', 'approved', 'used', 'expired', 'revoked'].includes(raw.state as string))
    return fail('state-impossible');
  const disclosure = record.disclosure;
  if (disclosure === undefined) return fail('wrong-shape');
  let binding: DisclosureBinding;
  try {
    binding = canonicalDisclosureBinding(disclosure);
  } catch {
    return fail('wrong-shape');
  }
  if (raw.pendingMs !== APPROVAL_LIFETIMES.confirm || raw.approvedMs !== APPROVAL_LIFETIMES.approved) {
    return fail('lifetime-mismatch');
  }
  const times: Partial<Record<Stamp, number>> = {};
  for (const field of TIMESTAMPS) {
    const at = timeOf(raw[field]);
    if (at === 'invalid') return fail('timestamp-invalid');
    if (at !== null) times[field] = at;
  }
  const { createdAt, expiresAt, approvedAt, usableUntil, usedAt, revokedAt, expiredAt } = times;
  if (createdAt === undefined || expiresAt === undefined) return fail('timestamp-missing');
  if (expiresAt - createdAt !== APPROVAL_LIFETIMES.confirm) return fail('lifetime-mismatch');
  const state = raw.state as ApprovalState;
  const approved = approvedAt !== undefined || usableUntil !== undefined;
  if ((approvedAt === undefined) !== (usableUntil === undefined)) return fail('timestamp-missing');
  if (approvedAt !== undefined && usableUntil !== undefined) {
    if (!(createdAt <= approvedAt && approvedAt < expiresAt)) return fail('timestamp-misordered');
    if (usableUntil - approvedAt !== APPROVAL_LIFETIMES.approved) return fail('lifetime-mismatch');
  }
  if (state === 'approved' && !approved) return fail('timestamp-missing');
  if (state === 'used' && usedAt === undefined) return fail('timestamp-missing');
  if (state !== 'used' && usedAt !== undefined) return fail('timestamp-misplaced');
  if (state === 'revoked' && revokedAt === undefined) return fail('timestamp-missing');
  if (state !== 'revoked' && revokedAt !== undefined) return fail('timestamp-misplaced');
  if (state === 'expired' && expiredAt === undefined) return fail('timestamp-missing');
  if (state !== 'expired' && expiredAt !== undefined) return fail('timestamp-misplaced');
  const deadline = usableUntil ?? expiresAt;
  if (usedAt !== undefined && !(approvedAt !== undefined && approvedAt <= usedAt && usedAt < deadline)) {
    return fail('timestamp-misordered');
  }
  if (revokedAt !== undefined && !(createdAt <= revokedAt && revokedAt < deadline)) return fail('timestamp-misordered');
  if (expiredAt !== undefined && expiredAt < (approvedAt ?? createdAt)) return fail('timestamp-misordered');
  if (
    raw.challengeAttempts !== 0 &&
    raw.challengeAttempts !== 1 &&
    raw.challengeAttempts !== 2 &&
    raw.challengeAttempts !== 3
  ) {
    return fail('evidence-invalid');
  }
  const via = raw.approvedVia;
  const digest = raw.approvedDigest;
  if (!approved) {
    if (via !== undefined || digest !== undefined) return fail('evidence-contradictory');
  } else {
    if ((via !== 'terminal' && via !== 'app') || digest !== binding.digest) return fail('evidence-contradictory');
  }
  return null;
}

/** The identity the binding covers is also consistent with itself: who it belongs to, and what it is about. */
function checkIdentity(
  record: ApprovalRecord,
  raw: Record<string, unknown>,
  kind: 'send' | 'change' | 'download',
): Fail | null {
  if (!isKnownChannel(raw.channel)) return fail('identity-contradiction');
  const scope = raw.ownerScope;
  if (kind !== 'change') {
    if (scope !== 'owner' || typeof raw.inboxId !== 'string' || raw.inboxId === '') {
      return fail('identity-contradiction');
    }
  } else {
    const target = record.change?.target;
    const expected =
      target === null || target === undefined ? 'global' : target.id === undefined ? 'prospective' : 'owner';
    if (scope !== expected) return fail('identity-contradiction');
    if (raw.inboxId !== (expected === 'owner' ? target?.id : '')) return fail('identity-contradiction');
  }
  if (kind === 'send') {
    if (typeof raw.sendEpoch !== 'number' || !Number.isInteger(raw.sendEpoch) || raw.sendEpoch < 0) {
      return fail('identity-contradiction');
    }
  } else if (raw.sendEpoch !== undefined) {
    return fail('identity-contradiction');
  }
  if (kind === 'download') {
    const download = record.download;
    if (download === undefined || download.target.id !== raw.inboxId) return fail('identity-contradiction');
    // The names a listing shows are the names the files are bound to, in the same order — compared only when there is
    // a listing to compare.
    if (download.listing !== undefined) {
      const listed = download.listing.map((file) => file.name);
      if (canonicalJson(listed) !== canonicalJson(download.names)) return fail('listing-mismatch');
    }
  }
  return null;
}

/** The lifetime profile: what the route says, and nothing the record could have chosen for itself. */
function checkLifetime(raw: Record<string, unknown>, kind: 'send' | 'change' | 'download'): Fail | null {
  if (kind === 'download') {
    if (raw.pendingMs !== APPROVAL_LIFETIMES.download) return fail('lifetime-mismatch');
    if (raw.route !== undefined || raw.approvedMs !== undefined) return fail('lifetime-mismatch');
    return null;
  }
  if (raw.route !== 'chat' && raw.route !== 'confirm') return fail('lifetime-mismatch');
  if (raw.pendingMs !== pendingMsOf(raw.route)) return fail('lifetime-mismatch');
  if (raw.approvedMs !== APPROVAL_LIFETIMES.approved) return fail('lifetime-mismatch');
  return null;
}

/**
 * Every state-specific timestamp in its place and in order: exact pending lifetimes, the approved window, the claim's
 * `sendingAt` and heartbeat, `usedAt` (= `sentAt` on a send), `failedAt`, `revokedAt`, `expiredAt` — with the one
 * stated exemption, an expiry forced by a clock seen before the record's own times.
 */
function checkTimestamps(
  raw: Record<string, unknown>,
  kind: 'send' | 'change' | 'download',
  state: ApprovalState,
  times: Partial<Record<Stamp, number>>,
): Fail | null {
  const { createdAt, expiresAt } = times;
  if (createdAt === undefined || expiresAt === undefined) return fail('timestamp-missing');
  if (expiresAt - createdAt !== raw.pendingMs) return fail('lifetime-mismatch');

  const anomaly = state === 'expired' && raw.reason === CLOCK_ANOMALY;
  if (raw.reason === CLOCK_ANOMALY && !anomaly) return fail('timestamp-misplaced');

  // Where each one may be at all.
  const present = (field: Stamp) => times[field] !== undefined;
  const onlyIn = (field: Stamp, states: readonly ApprovalState[]) => !present(field) || states.includes(state);
  if (kind === 'download' && (present('approvedAt') || present('usableUntil'))) return fail('timestamp-misplaced');
  if (kind !== 'send') {
    for (const field of ['sendingAt', 'sendingHeartbeatAt', 'sentAt', 'failedAt'] as const) {
      if (present(field)) return fail('timestamp-misplaced');
    }
  }
  if (!onlyIn('usedAt', ['used'])) return fail('timestamp-misplaced');
  if (!onlyIn('sentAt', ['used'])) return fail('timestamp-misplaced');
  if (!onlyIn('failedAt', ['failed'])) return fail('timestamp-misplaced');
  if (!onlyIn('revokedAt', ['revoked'])) return fail('timestamp-misplaced');
  if (!onlyIn('expiredAt', ['expired'])) return fail('timestamp-misplaced');
  if (kind === 'send') {
    if (!onlyIn('sendingAt', CLAIMED_SEND) || !onlyIn('sendingHeartbeatAt', CLAIMED_SEND)) {
      return fail('timestamp-misplaced');
    }
    if (CLAIMED_SEND.includes(state) && !present('sendingAt')) return fail('timestamp-missing');
  }
  if (state === 'used' && !present('usedAt')) return fail('timestamp-missing');
  if (state === 'used' && kind === 'send' && !present('sentAt')) return fail('timestamp-missing');
  if (state === 'failed' && !present('failedAt')) return fail('timestamp-missing');
  if (state === 'revoked' && !present('revokedAt')) return fail('timestamp-missing');
  if (state === 'expired' && !present('expiredAt')) return fail('timestamp-missing');

  // The approved window: together or not at all, and only on a send or a change that reached `approved`.
  const { approvedAt, usableUntil } = times;
  if ((approvedAt === undefined) !== (usableUntil === undefined)) return fail('timestamp-missing');
  if (state === 'approved' && kind !== 'download' && approvedAt === undefined) return fail('timestamp-missing');
  if (approvedAt !== undefined && usableUntil !== undefined) {
    if (state === 'pending') return fail('timestamp-misplaced');
    // Strictly before the pending deadline: an approval at the boundary is an expiry, and never a stored approval.
    if (!(createdAt <= approvedAt && approvedAt < expiresAt)) return fail('timestamp-misordered');
    if (usableUntil - approvedAt !== raw.approvedMs) return fail('lifetime-mismatch');
  }
  const deadline = usableUntil ?? expiresAt;
  const since = approvedAt ?? createdAt;

  // A claim, in order: in the window it was made in, then heartbeat, then its one ending.
  const { sendingAt, sendingHeartbeatAt, usedAt, sentAt, failedAt, revokedAt, expiredAt } = times;
  if (sendingAt !== undefined && !(since <= sendingAt && sendingAt < deadline)) return fail('timestamp-misordered');
  if (sendingHeartbeatAt !== undefined) {
    if (sendingAt === undefined || sendingHeartbeatAt < sendingAt) return fail('timestamp-misordered');
    const ended = usedAt ?? failedAt;
    if (ended !== undefined && sendingHeartbeatAt > ended) return fail('timestamp-misordered');
  }
  if (kind === 'send' && state === 'used') {
    if (typeof raw.sentMessageId !== 'string' || raw.sentMessageId === '') return fail('sent-id-missing');
    if (sentAt === undefined || usedAt !== sentAt) return fail('timestamp-misordered');
    if (sendingAt === undefined || sentAt < sendingAt) return fail('timestamp-misordered');
  } else if (raw.sentMessageId !== undefined) {
    return fail('timestamp-misplaced');
  }
  if (failedAt !== undefined && (sendingAt === undefined || failedAt < sendingAt)) return fail('timestamp-misordered');
  if (kind !== 'send' && usedAt !== undefined && !(since <= usedAt && usedAt < deadline)) {
    return fail('timestamp-misordered');
  }
  if (revokedAt !== undefined && !(since <= revokedAt && revokedAt < deadline)) return fail('timestamp-misordered');
  if (expiredAt !== undefined && !anomaly && expiredAt < since) return fail('timestamp-misordered');
  return null;
}

/**
 * Who decided, per kind: a send or a change reaches `approved` only at the terminal or in a trusted form (a change at
 * the terminal only), and carries the binding it approved; a download records the answer, bound to its binding; a
 * record claimed straight from `pending` in the chat carries none of it.
 */
function checkEvidence(
  record: ApprovalRecord,
  raw: Record<string, unknown>,
  kind: 'send' | 'change' | 'download',
  state: ApprovalState,
): Fail | null {
  const via = raw.approvedVia;
  if (via !== undefined && via !== 'terminal' && via !== 'elicitation') return fail('evidence-invalid');
  if (kind === 'download') {
    const answer = record.download?.answer;
    const answered = via !== undefined || raw.approvedDigest !== undefined || answer !== undefined;
    if (raw.approvedBindingDigest !== undefined) return fail('evidence-contradictory');
    if (!answered) return state === 'approved' ? fail('evidence-missing') : null;
    if (via === undefined || raw.approvedDigest === undefined || answer === undefined) return fail('evidence-missing');
    if (state === 'pending') return fail('evidence-contradictory');
    const expected = sha256Hex(canonicalJson({ bindingDigest: record.bindingDigest, answer }));
    if (raw.approvedDigest !== expected) return fail('evidence-contradictory');
    return null;
  }
  if (raw.approvedDigest !== undefined) return fail('evidence-contradictory');
  const approved = raw.approvedAt !== undefined;
  if (!approved) {
    return via !== undefined || raw.approvedBindingDigest !== undefined ? fail('evidence-contradictory') : null;
  }
  if (via === undefined || raw.approvedBindingDigest === undefined) return fail('evidence-missing');
  // A change's `confirm` means a person at a terminal: a form is not what that policy asked for.
  if (kind === 'change' && via !== 'terminal') return fail('evidence-invalid');
  if (raw.approvedBindingDigest !== record.bindingDigest) return fail('evidence-contradictory');
  return null;
}
