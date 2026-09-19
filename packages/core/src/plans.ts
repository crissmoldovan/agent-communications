import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from './digest.ts';
import { CommsError } from './errors.ts';
import { writeFileAtomic } from './fs.ts';
import { newPlanToken, PLAN_TOKEN_PATTERN } from './ids.ts';
import { withFileLock } from './lock.ts';

/**
 * Bulk mailbox changes (more than 20 messages, anything driven by a query, and every trash) are two-step: a dry run
 * returns a plan token bound to the exact set of ids and the exact change; executing requires that token, once, within
 * ten minutes. The ids are resolved at dry-run time, so a query cannot silently grow between preview and execution.
 */

export interface PlanRecord {
  token: string;
  inboxId: string;
  operation: string;
  /** Digest of the operation parameters (labels added/removed, archive, trash…). */
  paramsDigest: string;
  /** Digest of the sorted id list. */
  idsDigest: string;
  count: number;
  createdAt: string;
  expiresAt: string;
}

export const PLAN_TTL_MS: number = 10 * 60 * 1000;

export function idsDigest(ids: readonly string[]): string {
  return sha256Hex([...new Set(ids)].sort().join('\n'));
}

export function paramsDigest(params: unknown): string {
  return sha256Hex(canonicalJson(params));
}

export class PlanStore {
  readonly directory: string;
  readonly #now: () => Date;

  constructor(stateDir: string, now: () => Date = () => new Date()) {
    this.directory = join(stateDir, 'plans');
    this.#now = now;
  }

  #path(token: string): string {
    if (!PLAN_TOKEN_PATTERN.test(token)) {
      throw new CommsError('USAGE', `"${token}" is not a plan token`, {
        hint: 'Run the operation with --dry-run first.',
      });
    }
    return join(this.directory, `${token}.json`);
  }

  async create(input: {
    inboxId: string;
    operation: string;
    params: unknown;
    ids: readonly string[];
  }): Promise<PlanRecord> {
    const now = this.#now();
    const record: PlanRecord = {
      token: newPlanToken(),
      inboxId: input.inboxId,
      operation: input.operation,
      paramsDigest: paramsDigest(input.params),
      idsDigest: idsDigest(input.ids),
      count: new Set(input.ids).size,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
    };
    await writeFileAtomic(this.#path(record.token), JSON.stringify(record));
    return record;
  }

  /**
   * Consumes a plan exactly once. It must be for the same inbox, operation, parameters and ids; the file is deleted
   * inside the lock, so a second consume fails.
   */
  async consume(
    token: string,
    expected: { inboxId: string; operation: string; params: unknown; ids: readonly string[] },
  ): Promise<PlanRecord> {
    const path = this.#path(token);
    return withFileLock(`${path}.lock`, async () => {
      let record: PlanRecord;
      try {
        record = JSON.parse(await readFile(path, 'utf8')) as PlanRecord;
      } catch {
        throw new CommsError('APPROVAL_VOID', 'that plan does not exist or was already used', {
          hint: 'Run the operation with --dry-run again.',
        });
      }
      if (this.#now() >= new Date(record.expiresAt)) {
        await rm(path, { force: true });
        throw new CommsError('APPROVAL_EXPIRED', 'that plan expired', {
          hint: 'Run the operation with --dry-run again.',
        });
      }
      let mismatch: string | undefined;
      if (record.inboxId !== expected.inboxId) mismatch = 'a different inbox';
      else if (record.operation !== expected.operation) mismatch = 'a different operation';
      else if (record.paramsDigest !== paramsDigest(expected.params)) mismatch = 'different changes';
      else if (record.idsDigest !== idsDigest(expected.ids)) mismatch = 'a different set of messages';
      if (mismatch) {
        // The plan is left alive. It only ever authorises its own recorded change, so keeping it costs nothing —
        // and burning it here punished a caller for a typo by making them re-run the dry run for a plan that was
        // perfectly good.
        throw new CommsError('APPROVAL_VOID', `that plan was made for ${mismatch}`, {
          hint: 'Run the operation again with the parameters the plan was made for, or --dry-run for a new plan.',
        });
      }
      // Single use, on the one path that used it.
      await rm(path, { force: true });
      return record;
    });
  }
}
