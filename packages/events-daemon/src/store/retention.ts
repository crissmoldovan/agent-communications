export const HOUR_MS: number = 60 * 60 * 1000;
export const DAY_MS: number = 24 * HOUR_MS;
export const MAX_DRYRUN_RETENTION_MS: number = DAY_MS;
export const MAX_SSE_REPLAY_RETENTION_MS: number = 7 * DAY_MS;

export class RetentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetentionError';
  }
}

function checkedInstant(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) throw new RetentionError(`${field} must be an integer database time`);
  return value;
}

function checkedRetention(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RetentionError(`${field} must be a positive whole duration`);
  return value;
}

/** Computes the one fixed end for a record; retries must reuse, never recalculate, this result. */
export function fixedDeadline(clockStart: number, retentionMs: number): number {
  const start = checkedInstant(clockStart, 'clock start');
  const duration = checkedRetention(retentionMs, 'retention');
  const deadline = start + duration;
  if (!Number.isSafeInteger(deadline)) throw new RetentionError('retention deadline is outside database integer range');
  return deadline;
}

/** Shared source content must use the shortest retention among every rule version that may still be owed it. */
export function stageDeadline(stagedAt: number, owedIngestRetentions: readonly number[]): number {
  if (owedIngestRetentions.length === 0)
    throw new RetentionError('staged content needs at least one owed ingest retention');
  return fixedDeadline(
    stagedAt,
    Math.min(...owedIngestRetentions.map((value) => checkedRetention(value, 'ingest retention'))),
  );
}

/** Dry-run is local but is still a content record, capped by D8 at 24 hours. */
export function dryrunDeadline(appendedAt: number, retentionMs: number): number {
  if (checkedRetention(retentionMs, 'dry-run retention') > MAX_DRYRUN_RETENTION_MS) {
    throw new RetentionError('dry-run retention may not exceed 24 hours');
  }
  return fixedDeadline(appendedAt, retentionMs);
}

/** SSE replay is a separately retained content record, capped at seven days. */
export function sseReplayDeadline(appendedAt: number, retentionMs: number): number {
  if (checkedRetention(retentionMs, 'SSE replay retention') > MAX_SSE_REPLAY_RETENTION_MS) {
    throw new RetentionError('SSE replay retention may not exceed seven days');
  }
  return fixedDeadline(appendedAt, retentionMs);
}

/** A tightening can only move an already-stored deadline earlier. */
export function shortenDeadline(currentDeadline: number, tightenedDeadline: number): number {
  return Math.min(
    checkedInstant(currentDeadline, 'current deadline'),
    checkedInstant(tightenedDeadline, 'tightened deadline'),
  );
}

export interface RetentionDeadlineInput {
  readonly stagedAt: number;
  readonly ingestRetentionMs: number;
  readonly deliveryCreatedAt: number;
  readonly deliveryRetentionMs: number;
  readonly dryrunAppendedAt: number;
  readonly dryrunRetentionMs: number;
}

export interface RetentionDeadlines {
  readonly stageExpiresAt: number;
  readonly decisionDeadline: number;
  readonly deliveryExpiresAt: number;
  readonly dryrunExpiresAt: number;
}

/** Central creation-time calculation for B1 staged, projection, delivery and local dry-run content. */
export function createRetentionDeadlines(input: RetentionDeadlineInput): RetentionDeadlines {
  return {
    stageExpiresAt: stageDeadline(input.stagedAt, [input.ingestRetentionMs]),
    decisionDeadline: fixedDeadline(input.stagedAt, input.ingestRetentionMs),
    deliveryExpiresAt: fixedDeadline(input.deliveryCreatedAt, input.deliveryRetentionMs),
    dryrunExpiresAt: dryrunDeadline(input.dryrunAppendedAt, input.dryrunRetentionMs),
  };
}
