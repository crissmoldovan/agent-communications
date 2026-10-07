import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createRetentionDeadlines,
  dryrunDeadline,
  MAX_DRYRUN_RETENTION_MS,
  shortenDeadline,
  stageDeadline,
} from '../src/store/retention.ts';

test('RET-B1: event-content deadlines are fixed from their specified clock start and dry-run never exceeds 24 hours', () => {
  const created = createRetentionDeadlines({
    stagedAt: 1_000,
    ingestRetentionMs: 10_000,
    deliveryCreatedAt: 9_000,
    deliveryRetentionMs: 2_000,
    dryrunAppendedAt: 11_000,
    dryrunRetentionMs: 3_000,
  });
  assert.equal(created.stageExpiresAt, 11_000);
  assert.equal(created.decisionDeadline, 11_000, 'projection deadline starts at first durable staging');
  assert.equal(created.deliveryExpiresAt, 11_000, 'delivery starts its independently approved clock at creation');
  assert.equal(created.dryrunExpiresAt, 14_000);
  assert.equal(stageDeadline(1_000, [10_000, 4_000]), 5_000, 'shared staging takes the shortest owed retention');
  assert.equal(shortenDeadline(14_000, 12_000), 12_000);
  assert.equal(shortenDeadline(12_000, 14_000), 12_000, 'a deadline can never be extended by retry or read');
  assert.throws(() => dryrunDeadline(0, MAX_DRYRUN_RETENTION_MS + 1), /24 hours/);
});
