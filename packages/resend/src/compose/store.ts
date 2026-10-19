import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appendPrivateLine,
  type Caps,
  CommsError,
  canonicalAddress,
  withFileLock,
  writeFileAtomic,
} from '@agentcomms/core';
import { type BehaviourCheck, type OutboundMessage, PREPARED_ID_PATTERN } from './message.ts';

/**
 * Two small stores under core's state directory, both this package's own.
 *
 * **Prepared messages** — `resend/prepared/<rp_…>.json`: the message a preview showed, kept so execute sends exactly
 * that and nothing passed to it later. The approval record points at it by its id and is bound to its digest.
 *
 * **The send record** — `resend/sends/<acc_…>.jsonl`, append-only: every attempt, before the request leaves, and its
 * outcome after. It is the local answer to "did that go?" when Resend's is unknown, the count the rate caps are taken
 * from across every process, and the list of who this account has written to.
 */

export interface PreparedMessage {
  preparedId: string;
  accountId: string;
  message: OutboundMessage;
  /**
   * What the behaviour rules were asked about it at prepare, which its digest binds and execute asks again (design
   * 2026-10-19-agent-behaviour-rules, B4). Absent from a message an earlier release prepared.
   */
  behaviour?: BehaviourCheck | undefined;
  digest: string;
  links: string[];
  warnings: string[];
  createdAt: string;
}

export class PreparedStore {
  readonly directory: string;

  constructor(stateDir: string) {
    this.directory = join(stateDir, 'resend', 'prepared');
  }

  #path(id: string): string {
    if (!PREPARED_ID_PATTERN.test(id)) throw new CommsError('USAGE', `"${id}" is not a prepared message id`);
    return join(this.directory, `${id}.json`);
  }

  async put(prepared: PreparedMessage): Promise<void> {
    await writeFileAtomic(this.#path(prepared.preparedId), `${JSON.stringify(prepared, null, 2)}\n`);
  }

  async get(id: string): Promise<PreparedMessage | null> {
    try {
      return JSON.parse(await readFile(this.#path(id), 'utf8')) as PreparedMessage;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

export type SendEvent = 'reserve' | 'release' | 'attempt' | 'sent' | 'failed' | 'unknown' | 'cancelled';

export interface SendLine {
  at: string;
  approvalId: string;
  event: SendEvent;
  /** Resend's id for the email, once known. */
  resendId?: string | undefined;
  recipients?: string[] | undefined;
  subject?: string | undefined;
  scheduledAt?: string | null | undefined;
  error?: string | undefined;
}

export type SendState = 'attempted' | 'sent' | 'failed' | 'unknown' | 'cancelled';

export interface SendSummary {
  approvalId: string;
  state: SendState;
  resendId?: string | undefined;
  recipients: string[];
  subject?: string | undefined;
  scheduledAt?: string | null | undefined;
  attemptedAt?: string | undefined;
  finishedAt?: string | undefined;
  error?: string | undefined;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export class SendRecords {
  readonly directory: string;
  readonly #now: () => Date;

  constructor(stateDir: string, now: () => Date = () => new Date()) {
    this.directory = join(stateDir, 'resend', 'sends');
    this.#now = now;
  }

  #path(accountId: string): string {
    if (!/^acc_[A-Z0-9]{16}$/.test(accountId)) throw new Error(`not an account id: ${accountId}`);
    return join(this.directory, `${accountId}.jsonl`);
  }

  async #lines(accountId: string): Promise<SendLine[]> {
    let text = '';
    try {
      text = await readFile(this.#path(accountId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const lines: SendLine[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        lines.push(JSON.parse(line) as SendLine);
      } catch {
        // A torn last line from a crash: the lines before it still stand.
      }
    }
    return lines;
  }

  /** Appends one line. `durable`, because an attempt must be on disk before the request that it records leaves. */
  async record(accountId: string, line: Omit<SendLine, 'at'>): Promise<void> {
    const path = this.#path(accountId);
    await withFileLock(`${path}.lock`, () =>
      appendPrivateLine(path, JSON.stringify({ at: this.#now().toISOString(), ...line }), { durable: true }),
    );
  }

  /** Reserves a slot against the caps, across every process, or refuses with the time the cap resets. */
  async reserve(accountId: string, approvalId: string, caps: Caps): Promise<void> {
    const path = this.#path(accountId);
    await withFileLock(`${path}.lock`, async () => {
      const now = this.#now().getTime();
      const active = new Map<string, number>();
      for (const line of await this.#lines(accountId)) {
        if (line.event === 'reserve') active.set(line.approvalId, new Date(line.at).getTime());
        if (line.event === 'release') active.delete(line.approvalId);
      }
      const times = [...active.values()].filter((at) => at > now - DAY).sort((a, b) => a - b);
      const hour = times.filter((at) => at > now - HOUR);
      if (hour.length >= caps.perHour || times.length >= caps.perDay) {
        const resetAt = new Date(
          hour.length >= caps.perHour ? (hour[0] ?? now) + HOUR : (times[0] ?? now) + DAY,
        ).toISOString();
        throw new CommsError('RATE_CAPPED', 'nothing was sent: the send limit for this account is reached', {
          hint: `Limits: ${caps.perHour} per hour, ${caps.perDay} per day. Next slot: ${resetAt}.`,
          details: { hour: hour.length, day: times.length, resetAt },
        });
      }
      await appendPrivateLine(path, JSON.stringify({ at: new Date(now).toISOString(), approvalId, event: 'reserve' }), {
        durable: true,
      });
    });
  }

  async release(accountId: string, approvalId: string): Promise<void> {
    await this.record(accountId, { approvalId, event: 'release' });
  }

  /** What is known locally about one send. */
  async summary(accountId: string, approvalId: string): Promise<SendSummary | null> {
    let found: SendSummary | null = null;
    for (const line of await this.#lines(accountId)) {
      if (line.approvalId !== approvalId || line.event === 'reserve' || line.event === 'release') continue;
      found ??= { approvalId, state: 'attempted', recipients: [] };
      if (line.event === 'attempt') {
        found.attemptedAt = line.at;
        found.recipients = line.recipients ?? found.recipients;
        found.subject = line.subject ?? found.subject;
        found.scheduledAt = line.scheduledAt ?? found.scheduledAt;
        continue;
      }
      found.state = line.event;
      found.finishedAt = line.at;
      if (line.resendId) found.resendId = line.resendId;
      if (line.error) found.error = line.error;
    }
    return found;
  }

  /** The send, if any, that produced a Resend email id. */
  async byResendId(accountId: string, resendId: string): Promise<SendSummary | null> {
    for (const line of await this.#lines(accountId)) {
      if (line.resendId === resendId) return this.summary(accountId, line.approvalId);
    }
    return null;
  }

  /** Whether a send from this account is known to have gone to this address. */
  async hasSentTo(accountId: string, address: string): Promise<boolean> {
    const wanted = canonicalAddress(address);
    const sent = new Set<string>();
    const recipients = new Map<string, string[]>();
    for (const line of await this.#lines(accountId)) {
      if (line.event === 'attempt') recipients.set(line.approvalId, line.recipients ?? []);
      if (line.event === 'sent') sent.add(line.approvalId);
    }
    for (const approvalId of sent) {
      if ((recipients.get(approvalId) ?? []).some((candidate) => canonicalAddress(candidate) === wanted)) return true;
    }
    return false;
  }
}
