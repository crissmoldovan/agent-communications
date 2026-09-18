import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SendPolicy } from './config.ts';
import { CommsError } from './errors.ts';
import { writeFileAtomic } from './fs.ts';
import { APPROVAL_ID_PATTERN, newApprovalId, newChallenge } from './ids.ts';
import { withFileLock } from './lock.ts';

/**
 * Approval records bind a send to exactly one draft version. The states:
 *
 *   pending ──approve──▶ approved ──claim──▶ sending ──▶ used
 *      │                     │                  └──────▶ failed
 *      └──claim (chat)───────┘
 *   pending|approved ──▶ expired (time) | revoked (voided: content changed, policy tightened, user revoked)
 *
 * Every transition is a compare-and-swap under a per-record lock, so a record is used at most once even when a CLI
 * and several MCP server processes race for it.
 */

export type ApprovalState = 'pending' | 'approved' | 'sending' | 'used' | 'failed' | 'expired' | 'revoked';
export type ApprovalChannel = 'chat' | 'elicitation' | 'terminal';

export interface Expectation {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
}

export interface ApprovalRecord {
  approvalId: string;
  inboxId: string;
  inboxSub?: string | undefined;
  draftId: string;
  /** Changes on every save of the draft; binding to it detects any edit, even one that restores identical content. */
  draftMessageId: string;
  digest: string;
  /** The digest the human was actually shown when approving through a confirm channel. */
  approvedDigest?: string | undefined;
  approvedVia?: ApprovalChannel | undefined;
  /** Policy at prepare time. Execution re-reads the live policy; this is for display and audit. */
  policy: SendPolicy;
  /** True when risk escalation raised a chat send to confirm. */
  escalated: boolean;
  riskFlags: string[];
  expect: Expectation;
  challenge: string;
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
  escalated: boolean;
  riskFlags: string[];
  expect: Expectation;
}

/** What the caller observed in the live draft at the moment of a transition. */
export interface LiveDraft {
  draftMessageId: string;
  digest: string;
}

export const APPROVAL_TTL_MS: number = 10 * 60 * 1000;
const TERMINAL: ReadonlySet<ApprovalState> = new Set(['used', 'failed', 'expired', 'revoked']);

function refuse(reason: string, record?: ApprovalRecord, hint?: string): CommsError {
  return new CommsError('APPROVAL_REQUIRED', `nothing was sent: ${reason}`, {
    hint: hint ?? 'Prepare the send again and show the new preview to the user.',
    details: record ? { approvalId: record.approvalId, state: record.state } : {},
  });
}

export class ApprovalStore {
  readonly directory: string;
  readonly #now: () => Date;
  readonly #ttlMs: number;

  constructor(stateDir: string, options: { now?: () => Date; ttlMs?: number } = {}) {
    this.directory = join(stateDir, 'approvals');
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.ttlMs ?? APPROVAL_TTL_MS;
  }

  #path(approvalId: string): string {
    if (!APPROVAL_ID_PATTERN.test(approvalId)) throw refuse(`"${approvalId}" is not an approval id`);
    return join(this.directory, `${approvalId}.json`);
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

  /** Applies expiry lazily: a pending or approved record past its deadline reads as expired. */
  #withExpiry(record: ApprovalRecord): ApprovalRecord {
    if ((record.state === 'pending' || record.state === 'approved') && this.#now() >= new Date(record.expiresAt)) {
      return { ...record, state: 'expired', reason: record.reason ?? 'the approval window passed' };
    }
    return record;
  }

  async create(input: CreateApprovalInput): Promise<ApprovalRecord> {
    const now = this.#now();
    // Built field by field: nothing a caller passes can set the id, the state or the challenge.
    const record: ApprovalRecord = {
      approvalId: newApprovalId(),
      inboxId: input.inboxId,
      inboxSub: input.inboxSub,
      draftId: input.draftId,
      draftMessageId: input.draftMessageId,
      digest: input.digest,
      policy: input.policy,
      escalated: input.escalated,
      riskFlags: [...input.riskFlags],
      expect: {
        to: [...input.expect.to],
        cc: [...input.expect.cc],
        bcc: [...input.expect.bcc],
        subject: input.expect.subject,
      },
      challenge: newChallenge(),
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
    return record ? this.#withExpiry(record) : null;
  }

  /** Compare-and-swap: runs `decide` on the current record under its lock; `decide` returns the next record or throws. */
  async #transition(approvalId: string, decide: (current: ApprovalRecord) => ApprovalRecord): Promise<ApprovalRecord> {
    const path = this.#path(approvalId);
    return withFileLock(`${path}.lock`, async () => {
      const stored = await this.#read(approvalId);
      if (!stored) throw refuse(`no approval ${approvalId}`);
      const current = this.#withExpiry(stored);
      if (current.state === 'expired' && stored.state !== 'expired') {
        await this.#write({ ...current, updatedAt: this.#now().toISOString() });
      }
      const next = decide(current);
      await this.#write({ ...next, updatedAt: this.#now().toISOString() });
      return next;
    });
  }

  /**
   * A human approved through a confirm channel. The draft must still be exactly what the record was prepared for:
   * otherwise the record is voided, because the human would be approving content the record does not describe.
   */
  async approve(approvalId: string, via: 'elicitation' | 'terminal', live: LiveDraft): Promise<ApprovalRecord> {
    let voided: ApprovalRecord | null = null;
    const result = await this.#transition(approvalId, (current) => {
      if (current.state !== 'pending') throw refuse(`the approval is ${current.state}`, current);
      if (live.draftMessageId !== current.draftMessageId || live.digest !== current.digest) {
        voided = { ...current, state: 'revoked', reason: 'the draft changed after the preview was prepared' };
        return voided;
      }
      return { ...current, state: 'approved', approvedDigest: live.digest, approvedVia: via };
    });
    if (voided) throw refuse('the draft changed after the preview was prepared', result);
    return result;
  }

  /**
   * Claims the record for sending, once. Checks, against what the caller just read from the provider and the live
   * policy: same inbox and account, content unchanged, policy allows it, and — under confirm, or when escalated — a
   * human approved exactly this digest. Any failure voids the record so it cannot be retried.
   */
  async claimForSend(
    approvalId: string,
    live: LiveDraft & { inboxId: string; inboxSub?: string | undefined; policy: SendPolicy; expect: Expectation },
  ): Promise<ApprovalRecord> {
    let failure: string | null = null;
    const result = await this.#transition(approvalId, (current) => {
      if (current.state !== 'pending' && current.state !== 'approved') {
        throw refuse(`the approval is ${current.state}`, current);
      }
      const fail = (reason: string): ApprovalRecord => {
        failure = reason;
        return { ...current, state: 'revoked', reason };
      };
      if (live.inboxId !== current.inboxId) return fail('the approval belongs to a different inbox');
      if (current.inboxSub && live.inboxSub && current.inboxSub !== live.inboxSub) {
        return fail('the inbox is now connected to a different account');
      }
      if (live.policy === 'never') return fail('sending is turned off for this inbox (policy: never)');
      if (live.draftMessageId !== current.draftMessageId) return fail('the draft was edited after the preview');
      if (live.digest !== current.digest) return fail('the draft content changed after the preview');
      if (!sameExpectation(live.expect, current.expect)) {
        return fail('the recipients or subject given do not match the prepared draft');
      }
      const needsHuman = live.policy === 'confirm' || current.escalated;
      if (needsHuman) {
        if (current.state !== 'approved') {
          failure = 'this send needs approval outside the chat first';
          throw refuse(failure, current, 'Ask the user to approve it (terminal or form), or send it from Gmail.');
        }
        if (current.approvedDigest !== live.digest)
          return fail('the approved content is not the content now in the draft');
      }
      return { ...current, state: 'sending' };
    });
    if (failure && result.state === 'revoked') throw refuse(failure, result);
    return result;
  }

  /** Records the outcome of the one send attempt. */
  async complete(approvalId: string, outcome: { sentMessageId: string } | { error: string }): Promise<ApprovalRecord> {
    return this.#transition(approvalId, (current) => {
      if (current.state !== 'sending') throw refuse(`the approval is ${current.state}, not sending`, current);
      return 'sentMessageId' in outcome
        ? { ...current, state: 'used', sentMessageId: outcome.sentMessageId }
        : { ...current, state: 'failed', reason: outcome.error };
    });
  }

  /** Voids a pending or approved record (user revoked it, or policy tightened). Terminal records are left alone. */
  async revoke(approvalId: string, reason: string): Promise<ApprovalRecord> {
    return this.#transition(approvalId, (current) =>
      TERMINAL.has(current.state) || current.state === 'sending' ? current : { ...current, state: 'revoked', reason },
    );
  }

  async list(filter: { inboxId?: string; states?: ApprovalState[] } = {}): Promise<ApprovalRecord[]> {
    let names: string[];
    try {
      names = (await readdir(this.directory)).filter((n) => n.endsWith('.json'));
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

function sameList(a: readonly string[], b: readonly string[]): boolean {
  const norm = (list: readonly string[]) => [...new Set(list.map((x) => x.trim().toLowerCase()))].sort().join('\n');
  return norm(a) === norm(b);
}

export function sameExpectation(a: Expectation, b: Expectation): boolean {
  return (
    sameList(a.to, b.to) && sameList(a.cc, b.cc) && sameList(a.bcc, b.bcc) && a.subject.trim() === b.subject.trim()
  );
}
