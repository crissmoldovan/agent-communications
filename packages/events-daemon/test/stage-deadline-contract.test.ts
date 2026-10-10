import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSourceStageRetention, resolveStageRetryDeadline } from '../src/store/retention.ts';

test('D4a: every source stage fixes its first timestamp and shortest owed ingest deadline', () => {
  const stage = createSourceStageRetention(1_000, [9_000, 2_000]);
  assert.deepEqual(stage, { stagedAt: 1_000, stageExpiresAt: 3_000 });
  assert.equal(
    createSourceStageRetention(stage.stagedAt, [9_000, 2_000, 20_000]).stageExpiresAt,
    stage.stageExpiresAt,
    'a later, looser debt cannot extend an existing stage',
  );
});

test('D4a: a source retry chooses the earlier deadline and gives equal deadlines to retention expiry', () => {
  assert.deepEqual(
    resolveStageRetryDeadline({ now: 1_999, firstFailedAt: 1_000, stageExpiresAt: 3_000, retryWindowMs: 1_000 }),
    { state: 'retry', deadline: 2_000 },
  );
  assert.deepEqual(
    resolveStageRetryDeadline({ now: 2_000, firstFailedAt: 1_000, stageExpiresAt: 5_000, retryWindowMs: 1_000 }),
    { state: 'unresolvable', deadline: 2_000 },
  );
  assert.deepEqual(
    resolveStageRetryDeadline({ now: 3_000, firstFailedAt: 1_000, stageExpiresAt: 3_000, retryWindowMs: 2_000 }),
    { state: 'retention-expired', deadline: 3_000 },
  );
});
