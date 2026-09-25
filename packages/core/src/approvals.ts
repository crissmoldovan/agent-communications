import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ChangePolicy,
  canonicalLoosening,
  type Loosening,
  type SendPolicy,
  type SettingChange,
  sameLoosening,
} from './config.ts';
import { canonicalJson, normaliseAddress, sha256Hex } from './digest.ts';
import { CommsError, type ErrorCode } from './errors.ts';
import { ensurePrivateDir, writeFileAtomic } from './fs.ts';
import { APPROVAL_ID_PATTERN, challengeMatches, hashChallenge, newApprovalId, newChallenge } from './ids.ts';
import { withFileLock } from './lock.ts';

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
 */

export type ApprovalState = 'pending' | 'approved' | 'sending' | 'used' | 'failed' | 'unknown' | 'expired' | 'revoked';
export type ApprovalChannel = 'elicitation' | 'terminal';

/**
 * What an approval permits: a send (a mail, a post, a reaction) or a change to the configuration.
 *
 * One store for both, so a change gets the machinery a send already has — expiry, single use, the typed code — and
 * a kind on every record, so that neither can be spent as the other. Without it, a person who approved a post at a
 * terminal would also have approved whatever change an agent claimed under the same id.
 */
export type ApprovalKind = 'send' | 'change';

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
}

/** The kind of a record. Absent is a send: every record written before changes had approvals. */
export function approvalKind(record: Pick<ApprovalRecord, 'kind'>): ApprovalKind {
  return record.kind ?? 'send';
}

/**
 * The digest a change approval is bound to: its target, every loosened path with its before and after values, every
 * setting it writes with its before and after values, and its effects.
 *
 * The loosenings and the settings are sorted, because their order is an implementation detail and the same change must
 * digest the same however it is listed. The effects are not: they are what the person read, in the order they read it.
 */
export function changeDigest(change: Pick<ChangeBinding, 'target' | 'loosened' | 'settings' | 'effects'>): string {
  const target = change.target;
  return sha256Hex(
    canonicalJson({
      kind: 'change',
      target: target === null ? null : { kind: target.kind, name: target.name, id: target.id ?? null },
      loosened: change.loosened.map(canonicalLoosening).sort(),
      // The same four fields a loosening has, in the same canonical form.
      settings: (change.settings ?? []).map(canonicalLoosening).sort(),
      effects: [...change.effects],
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
  return 'the change is not the one that was approved';
}

/** Bumped whenever the canonical form of a digest changes; a record prepared under another version is refused. */
export const DIGEST_VERSION = 1;

export interface Expectation {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
}

export interface ApprovalRecord {
  approvalId: string;
  /** Absent on a send, so a send's record is byte for byte what it was before change approvals existed. */
  kind?: ApprovalKind | undefined;
  digestVersion: number;
  /** For a change: the id of the inbox or account it is about, or empty for one to the whole configuration. */
  inboxId: string;
  inboxSub?: string | undefined;
  draftId: string;
  /** Changes on every save of the draft; binding to it detects any edit, even one that restores identical content. */
  draftMessageId: string;
  digest: string;
  /** The digest the human was actually shown when approving through a confirm channel. */
  approvedDigest?: string | undefined;
  approvedVia?: ApprovalChannel | undefined;
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
  /** For a change: exactly what it permits. `digest` is `changeDigest` of this. */
  change?: ChangeBinding | undefined;
}

export interface CreateApprovalInput {
  inboxId: string;
  inboxSub?: string | undefined;
  draftId: string;
  draftMessageId: string;
  digest: string;
  policy: SendPolicy;
  requiredPolicy: SendPolicy;
  riskFlags: string[];
  expect: Expectation;
}

export interface CreateChangeApprovalInput {
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
  digest: string;
}

/** What the product making a claim tells the store about itself. */
export interface ClaimOptions {
  /**
   * What the caller is told when the send is waiting for a person: which command approves it, and what to run after.
   *
   * The product's to say, because the store is shared and the command that approves is not. The store used to say
   * it itself, in Gmail's words, so a Slack post held for approval told the agent to hand the person
   * `agent-gmail approve` — which cannot approve a Slack record — or to "send it from Gmail". Left out, the hint
   * names no product at all rather than the wrong one.
   */
  pendingHint?: string | undefined;
}

export const APPROVAL_TTL_MS: number = 10 * 60 * 1000;
/** A record left in `sending` this long belongs to a process that died mid-send: the outcome is unknown. */
export const SENDING_STALE_MS: number = 5 * 60 * 1000;
export const MAX_CHALLENGE_ATTEMPTS = 3;
const POLICY_RANK: Record<SendPolicy, number> = { chat: 0, confirm: 1, never: 2 };

/** The stricter of two policies. */
export function stricterPolicy(a: SendPolicy, b: SendPolicy): SendPolicy {
  return POLICY_RANK[a] >= POLICY_RANK[b] ? a : b;
}

function refuse(code: ErrorCode, reason: string, record?: ApprovalRecord, hint?: string): CommsError {
  return new CommsError(code, `nothing was sent: ${reason}`, {
    hint: hint ?? 'Prepare the send again and show the new preview to the user.',
    details: record ? { approvalId: record.approvalId, state: record.state } : {},
  });
}

/** The same refusal for a change, which sends nothing and so must not say that it did not. */
function refuseChange(code: ErrorCode, reason: string, record?: ApprovalRecord, hint?: string): CommsError {
  return new CommsError(code, `nothing was changed: ${reason}`, {
    hint: hint ?? 'Prepare the change again and show the new preview to the user.',
    details: record ? { approvalId: record.approvalId, state: record.state } : {},
  });
}

/** The refusal in the words of the record's own kind. */
function refusalFor(record: ApprovalRecord): typeof refuse {
  return approvalKind(record) === 'change' ? refuseChange : refuse;
}

/** The record as it may be shown to anyone, agents included: never the challenge hash. */
export function publicView(record: ApprovalRecord): Omit<ApprovalRecord, 'challengeHash'> {
  const { challengeHash: _hidden, ...rest } = record;
  return rest;
}

type Failure = { code: ErrorCode; reason: string };

export class ApprovalStore {
  readonly directory: string;
  readonly #now: () => Date;
  readonly #ttlMs: number;

  constructor(stateDir: string, options: { now?: () => Date; ttlMs?: number } = {}) {
    this.directory = join(stateDir, 'approvals');
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.ttlMs ?? APPROVAL_TTL_MS;
  }

  #path(approvalId: string, suffix = '.json'): string {
    if (!APPROVAL_ID_PATTERN.test(approvalId)) throw refuse('USAGE', `"${approvalId}" is not an approval id`);
    return join(this.directory, `${approvalId}${suffix}`);
  }

  async #read(approvalId: string): Promise<ApprovalRecord | null> {
    try {
      return JSON.parse(await readFile(this.#path(approvalId), 'utf8')) as ApprovalRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async #write(record: ApprovalRecord): Promise<void> {
    await writeFileAtomic(this.#path(record.approvalId), `${JSON.stringify(record, null, 2)}\n`);
  }

  /** Derived states: expiry for pending/approved, `unknown` for a send whose process died. */
  #derive(record: ApprovalRecord): ApprovalRecord {
    const now = this.#now().getTime();
    const expiresAt = new Date(record.expiresAt).getTime();
    const createdAt = new Date(record.createdAt).getTime();
    // Expired, and also: an expiry that does not parse, and a clock that has moved behind the record's own
    // creation. `now >= NaN` is false, so a record with a nonsense `expiresAt` never expired at all; and a clock
    // stepped backwards — an NTP correction, a resumed VM, a user changing the date — put an expired record back
    // into `pending`. Neither should be the difference between a send and no send.
    const unusable = !Number.isFinite(expiresAt) || (Number.isFinite(createdAt) && now < createdAt);
    if ((record.state === 'pending' || record.state === 'approved') && (unusable || now >= expiresAt)) {
      return {
        ...record,
        state: 'expired',
        reason: record.reason ?? (unusable ? 'the approval window cannot be read' : 'the approval window passed'),
      };
    }
    if (record.state === 'sending' && now - new Date(record.updatedAt).getTime() >= SENDING_STALE_MS) {
      return { ...record, state: 'unknown', reason: 'the sending process stopped before recording an outcome' };
    }
    return record;
  }

  async create(input: CreateApprovalInput): Promise<ApprovalRecord> {
    const now = this.#now();
    // Built field by field: nothing a caller passes can set the id, the state or a challenge.
    const record: ApprovalRecord = {
      approvalId: newApprovalId(),
      digestVersion: DIGEST_VERSION,
      inboxId: input.inboxId,
      inboxSub: input.inboxSub,
      draftId: input.draftId,
      draftMessageId: input.draftMessageId,
      digest: input.digest,
      policy: input.policy,
      requiredPolicy: stricterPolicy(input.policy, input.requiredPolicy),
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
      expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
      updatedAt: now.toISOString(),
    };
    await this.#write(record);
    return record;
  }

  async get(approvalId: string): Promise<ApprovalRecord | null> {
    const record = await this.#read(approvalId);
    return record ? this.#derive(record) : null;
  }

  /** Compare-and-swap under the record's lock. `decide` returns the next record (written) or throws (nothing written). */
  async #transition(approvalId: string, decide: (current: ApprovalRecord) => ApprovalRecord): Promise<ApprovalRecord> {
    const path = this.#path(approvalId);
    return withFileLock(`${path}.lock`, async () => {
      const stored = await this.#read(approvalId);
      if (!stored) throw refuse('NOT_FOUND', `no approval ${approvalId}`);
      const current = this.#derive(stored);
      if (current.state !== stored.state) await this.#write({ ...current, updatedAt: this.#now().toISOString() });
      if (current.digestVersion !== DIGEST_VERSION) {
        throw refusalFor(current)(
          'APPROVAL_VOID',
          'the approval was prepared by a different version of agent-communications',
          current,
        );
      }
      const next = decide(current);
      if (next !== current) await this.#write({ ...next, updatedAt: this.#now().toISOString() });
      return next;
    });
  }

  #stateError(record: ApprovalRecord): CommsError {
    const refusal = refusalFor(record);
    if (record.state === 'expired')
      return refusal('APPROVAL_EXPIRED', 'the approval expired before it was used', record);
    if (record.state === 'revoked') {
      return refusal('APPROVAL_VOID', `the approval was voided (${record.reason ?? 'revoked'})`, record);
    }
    return refusal('APPROVAL_REQUIRED', `the approval is ${record.state}`, record);
  }

  /**
   * Refuses a record of the other kind, writing nothing to it.
   *
   * Nothing written, because the caller made a mistake about an approval that may be perfectly good: voiding a post
   * somebody is about to approve, because an agent passed its id to a change, would punish the wrong party.
   */
  #requireKind(record: ApprovalRecord, kind: ApprovalKind): void {
    if (approvalKind(record) === kind) return;
    const id = record.approvalId;
    throw kind === 'send'
      ? refuse(
          'USAGE',
          `approval ${id} is for a configuration change, not a send`,
          record,
          `A person approves it with \`agentcomms approve ${id}\` — or \`agent-gmail approve\` or \`agent-slack approve\`, whichever is installed — and it permits only the change it was prepared for.`,
        )
      : refuseChange(
          'USAGE',
          `approval ${id} is for a send, not a configuration change`,
          record,
          'It is approved with the command that prepared it — `agent-gmail approve` or `agent-slack approve` — and permits only that send.',
        );
  }

  /** Issues a new challenge to show a human; only its hash is kept. */
  async issueChallenge(approvalId: string, kind: ApprovalKind = 'send'): Promise<string> {
    const challenge = newChallenge();
    await this.#transition(approvalId, (current) => {
      this.#requireKind(current, kind);
      if (current.state !== 'pending') throw this.#stateError(current);
      return { ...current, challengeHash: hashChallenge(challenge) };
    });
    return challenge;
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
  ): Promise<ApprovalRecord> {
    let failure: Failure | null = null;
    const result = await this.#transition(approvalId, (current) => {
      this.#requireKind(current, kind);
      if (current.state !== 'pending') throw this.#stateError(current);
      if (!current.challengeHash)
        throw refusalFor(current)('APPROVAL_REQUIRED', 'no challenge was issued for this approval', current);
      if (live.draftMessageId !== current.draftMessageId || live.digest !== current.digest) {
        const reason =
          kind === 'change'
            ? 'the change shown is not the one the approval was prepared for'
            : 'the draft changed after the preview was prepared';
        failure = { code: 'APPROVAL_VOID', reason };
        return { ...current, state: 'revoked', reason: failure.reason };
      }
      if (!challengeMatches(answer, current.challengeHash)) {
        const attempts = current.challengeAttempts + 1;
        if (attempts >= MAX_CHALLENGE_ATTEMPTS) {
          failure = { code: 'APPROVAL_VOID', reason: 'too many wrong answers to the challenge' };
          return { ...current, challengeAttempts: attempts, state: 'revoked', reason: failure.reason };
        }
        failure = { code: 'APPROVAL_REQUIRED', reason: 'the challenge did not match' };
        return { ...current, challengeAttempts: attempts };
      }
      return { ...current, state: 'approved', approvedDigest: live.digest, approvedVia: via, challengeHash: undefined };
    });
    const failed = failure as Failure | null;
    if (failed) throw refusalFor(result)(failed.code, failed.reason, result);
    return result;
  }

  /**
   * Claims the record for sending, once. Non-consuming refusals (not yet approved) leave the record untouched so the
   * human can still approve it; integrity failures (other inbox or account, edited or changed draft, different
   * recipients or subject) void it. Success creates the O_EXCL claim marker.
   */
  async claimForSend(
    approvalId: string,
    live: LiveDraft & { inboxId: string; inboxSub?: string | undefined; policy: SendPolicy; expect: Expectation },
    options: ClaimOptions = {},
  ): Promise<ApprovalRecord> {
    let failure: Failure | null = null;
    const result = await this.#transition(approvalId, (current) => {
      // Before anything else: a change approval names an account in the same field, and a send claimed against it
      // would otherwise be judged — and voided — as a send that went wrong.
      this.#requireKind(current, 'send');
      if (current.state !== 'pending' && current.state !== 'approved') throw this.#stateError(current);
      const voidWith = (code: ErrorCode, reason: string): ApprovalRecord => {
        failure = { code, reason };
        return { ...current, state: 'revoked', reason };
      };
      if (live.inboxId !== current.inboxId)
        return voidWith('APPROVAL_VOID', 'the approval belongs to a different inbox');
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
      if (live.policy === 'never')
        return voidWith('POLICY_NEVER', 'sending is turned off for this inbox (policy: never)');
      if (live.draftMessageId !== current.draftMessageId) {
        return voidWith('APPROVAL_VOID', 'the draft was edited after the preview');
      }
      if (live.digest !== current.digest)
        return voidWith('APPROVAL_VOID', 'the draft content changed after the preview');
      if (!sameExpectation(live.expect, current.expect)) {
        return voidWith('APPROVAL_VOID', 'the recipients or subject given do not match the prepared draft');
      }
      // A switch over the effective policy, so a policy value nobody thought about here cannot fall through to
      // "send it". `never` reached this way is not only the live setting: a record can carry
      // `requiredPolicy: never`, and reading only for `confirm` let that one straight through.
      const effective = stricterPolicy(live.policy, current.requiredPolicy);
      switch (effective) {
        case 'never':
          return voidWith('POLICY_NEVER', 'sending is turned off for this approval (policy: never)');
        case 'confirm': {
          if (current.state !== 'approved') {
            throw refuse(
              'APPROVAL_PENDING',
              'this send needs approval outside the chat first',
              current,
              options.pendingHint ??
                'Ask the user to approve it outside the chat, then try again with the same approval.',
            );
          }
          if (current.approvedDigest !== live.digest) {
            return voidWith('APPROVAL_VOID', 'the approved content is not the content now in the draft');
          }
          break;
        }
        case 'chat':
          break;
      }
      return { ...current, state: 'sending' };
    });
    const failed = failure as Failure | null;
    if (failed) throw refuse(failed.code, failed.reason, result);
    await this.#markClaimed(result);
    return result;
  }

  /** The file system's O_EXCL is the single-use guarantee, independent of the lock. */
  async #markClaimed(record: ApprovalRecord): Promise<void> {
    await ensurePrivateDir(this.directory);
    try {
      const marker = await open(this.#path(record.approvalId, '.claim'), 'wx', 0o600);
      await marker.writeFile(JSON.stringify({ pid: process.pid, at: this.#now().toISOString() }));
      await marker.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw refusalFor(record)('APPROVAL_VOID', 'this approval was already claimed by another process', record);
      }
      throw error;
    }
  }

  /**
   * A change approval, pending, bound to `changeDigest(input.change)`.
   *
   * The digest is computed here, never taken from the caller, so a record cannot claim to be bound to one change while
   * describing another. It stands in for the draft revision too, as a reaction's does: a change has no draft, and the
   * same value means the same change.
   */
  async createChange(input: CreateChangeApprovalInput): Promise<ApprovalRecord> {
    const now = this.#now();
    const change: ChangeBinding = {
      summary: input.change.summary,
      target: input.change.target === null ? null : { ...input.change.target },
      loosened: input.change.loosened.map((loosening) => ({ ...loosening })),
      settings: (input.change.settings ?? []).map((setting) => ({ ...setting })),
      effects: [...input.change.effects],
    };
    const digest = changeDigest(change);
    const record: ApprovalRecord = {
      approvalId: newApprovalId(),
      kind: 'change',
      digestVersion: DIGEST_VERSION,
      inboxId: change.target?.id ?? '',
      draftId: 'change',
      draftMessageId: digest,
      digest,
      policy: input.policy,
      requiredPolicy: input.policy,
      riskFlags: [],
      // Not an expectation of recipients — a change has none — but it is the field every listing already shows.
      expect: { to: [], cc: [], bcc: [], subject: change.summary },
      challengeAttempts: 0,
      state: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
      updatedAt: now.toISOString(),
      change,
    };
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
    const result = await this.#transition(approvalId, (current) => {
      this.#requireKind(current, 'change');
      if (current.state !== 'pending' && current.state !== 'approved') throw this.#stateError(current);
      const voidWith = (reason: string): ApprovalRecord => {
        failure = { code: 'APPROVAL_VOID', reason };
        return { ...current, state: 'revoked', reason };
      };
      if (digest !== current.digest) {
        return voidWith(
          current.change ? changeDrift(current.change, live.change) : 'the change is not the one that was approved',
        );
      }
      if (stricterPolicy(live.policy, current.requiredPolicy) !== 'chat') {
        if (current.state !== 'approved') {
          throw refuseChange(
            'APPROVAL_PENDING',
            'this change needs a person to approve it at a terminal first',
            current,
            options.pendingHint ??
              `Ask the user to run \`agentcomms approve ${approvalId}\` in their own terminal, then try again with the same approval.`,
          );
        }
        // `confirm` means a person at a terminal. An approval given any other way — a form in a client window, which
        // is how a send may be approved — is not what the policy asked for.
        if (current.approvedVia !== 'terminal') {
          return voidWith('the change policy is confirm, and this was not approved at a terminal');
        }
      }
      return { ...current, state: 'used' };
    });
    const failed = failure as Failure | null;
    if (failed) throw refuseChange(failed.code, failed.reason, result);
    await this.#markClaimed(result);
    return result;
  }

  /** Records the outcome of the one send attempt. */
  async complete(approvalId: string, outcome: { sentMessageId: string } | { error: string }): Promise<ApprovalRecord> {
    return this.#transition(approvalId, (current) => {
      if (current.state !== 'sending' && current.state !== 'unknown') throw this.#stateError(current);
      return 'sentMessageId' in outcome
        ? { ...current, state: 'used', sentMessageId: outcome.sentMessageId }
        : { ...current, state: 'failed', reason: outcome.error };
    });
  }

  /** Voids a pending or approved record (user revoked it, or policy tightened). Other records are left as they are. */
  async revoke(approvalId: string, reason: string): Promise<ApprovalRecord> {
    return this.#transition(approvalId, (current) =>
      current.state === 'pending' || current.state === 'approved' ? { ...current, state: 'revoked', reason } : current,
    );
  }

  async list(filter: { inboxId?: string; states?: ApprovalState[] } = {}): Promise<ApprovalRecord[]> {
    let names: string[];
    try {
      // The same pattern the store validates an id against, so a file this listing shows is a file it can open.
      // A looser one here silently skipped records whose names it had itself accepted as plausible.
      names = (await readdir(this.directory)).filter((name) => APPROVAL_ID_PATTERN.test(name.replace(/\.json$/, '')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: ApprovalRecord[] = [];
    for (const name of names) {
      const record = await this.get(name.slice(0, -5)).catch(() => null);
      if (!record) continue;
      if (filter.inboxId && record.inboxId !== filter.inboxId) continue;
      if (filter.states && !filter.states.includes(record.state)) continue;
      records.push(record);
    }
    return records.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }
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
