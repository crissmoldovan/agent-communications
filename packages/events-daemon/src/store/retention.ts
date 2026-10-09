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

/** The immutable timestamps assigned when source content first crosses the durable staging boundary. */
export interface SourceStageRetention {
  readonly stagedAt: number;
  readonly stageExpiresAt: number;
}

/**
 * Creates a source stage's one retention record. Callers that resume an existing row must reuse these stored values;
 * recalculating from a later rule set is not permitted because it could extend the approved retention.
 */
export function createSourceStageRetention(
  stagedAt: number,
  owedIngestRetentions: readonly number[],
): SourceStageRetention {
  return {
    stagedAt: checkedInstant(stagedAt, 'staged at'),
    stageExpiresAt: stageDeadline(stagedAt, owedIngestRetentions),
  };
}

export type StageRetryResolution =
  | { readonly state: 'retry'; readonly deadline: number }
  | { readonly state: 'unresolvable'; readonly deadline: number }
  | { readonly state: 'retention-expired'; readonly deadline: number };

/**
 * Resolves the one boundary shared by a materialisation retry and its retained source stage. Equality belongs to
 * retention expiry, the stricter terminal state, so no source call can follow the approved stage deadline.
 */
export function resolveStageRetryDeadline(input: {
  readonly now: number;
  readonly firstFailedAt: number;
  readonly stageExpiresAt: number;
  readonly retryWindowMs: number;
}): StageRetryResolution {
  const retryDeadline = fixedDeadline(input.firstFailedAt, input.retryWindowMs);
  const stageExpiresAt = checkedInstant(input.stageExpiresAt, 'stage expiry');
  const now = checkedInstant(input.now, 'current time');
  const deadline = Math.min(retryDeadline, stageExpiresAt);
  if (now < deadline) return { state: 'retry', deadline };
  return stageExpiresAt <= retryDeadline
    ? { state: 'retention-expired', deadline }
    : { state: 'unresolvable', deadline };
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
