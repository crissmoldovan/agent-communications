import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replacementIntentSummary } from '../src/runtime/replacements.ts';

test('APR-B1: doctor/status summary is content-free but retains nonterminal, failed and cancelled replacement intent states', () => {
  const database = {
    prepare() {
      return {
        all: () => [
          { status: 'pending-completion', failure_code: null, count: 1 },
          { status: 'failed', failure_code: 'COMPLETION_TIMEOUT', count: 1 },
          { status: 'cancelled', failure_code: 'AUTHORIZATION_REVOKED', count: 1 },
        ],
      };
    },
  };
  assert.deepEqual(replacementIntentSummary(database as never), [
    { status: 'pending-completion', failureCode: null, count: 1 },
    { status: 'failed', failureCode: 'COMPLETION_TIMEOUT', count: 1 },
    { status: 'cancelled', failureCode: 'AUTHORIZATION_REVOKED', count: 1 },
  ]);
});
