import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SendPolicy } from './config.ts';
import { normaliseAddress } from './digest.ts';
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
 */

export type ApprovalState = 'pending' | 'approved' | 'sending' | 'used' | 'failed' | 'unknown' | 'expired' | 'revoked';
export type ApprovalChannel = 'elicitation' | 'terminal';

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
  digestVersion: number;
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

/** What the caller observed in the live draft at the moment of a transition. */
export interface LiveDraft {
  draftMessageId: string;
  digest: string;
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
        throw refuse(
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
    if (record.state === 'expired')
      return refuse('APPROVAL_EXPIRED', 'the approval expired before it was used', record);
    if (record.state === 'revoked') {
      return refuse('APPROVAL_VOID', `the approval was voided (${record.reason ?? 'revoked'})`, record);
    }
    return refuse('APPROVAL_REQUIRED', `the approval is ${record.state}`, record);
  }

  /** Issues a new challenge to show a human; only its hash is kept. */
  async issueChallenge(approvalId: string): Promise<string> {
    const challenge = newChallenge();
    await this.#transition(approvalId, (current) => {
      if (current.state !== 'pending') throw this.#stateError(current);
      return { ...current, challengeHash: hashChallenge(challenge) };
    });
    return challenge;
  }

  /**
   * A human approved through a confirm channel by typing the issued challenge. The draft must still be exactly what the
   * record was prepared for; otherwise the record is voided, because the human would be approving content the record
   * does not describe. Three wrong answers void it too.
   */
  async approve(approvalId: string, via: ApprovalChannel, live: LiveDraft, answer: string): Promise<ApprovalRecord> {
    let failure: Failure | null = null;
    const result = await this.#transition(approvalId, (current) => {
      if (current.state !== 'pending') throw this.#stateError(current);
      if (!current.challengeHash)
        throw refuse('APPROVAL_REQUIRED', 'no challenge was issued for this approval', current);
      if (live.draftMessageId !== current.draftMessageId || live.digest !== current.digest) {
        failure = { code: 'APPROVAL_VOID', reason: 'the draft changed after the preview was prepared' };
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
    if (failed) throw refuse(failed.code, failed.reason, result);
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
  ): Promise<ApprovalRecord> {
    let failure: Failure | null = null;
    const result = await this.#transition(approvalId, (current) => {
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
              'Ask the user to approve it in the terminal (`agent-gmail approve <id>`) or in a trusted client form, or to send it from Gmail.',
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
    // The file system's O_EXCL is the single-use guarantee, independent of the lock.
    await ensurePrivateDir(this.directory);
    try {
      const marker = await open(this.#path(approvalId, '.claim'), 'wx', 0o600);
      await marker.writeFile(JSON.stringify({ pid: process.pid, at: this.#now().toISOString() }));
      await marker.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw refuse('APPROVAL_VOID', 'this approval was already claimed by another process', result);
      }
      throw error;
    }
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
