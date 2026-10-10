import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventDomainError } from '../src/domain/lifecycle.ts';
import { runCatalogueRuleTest } from '../src/runtime/b3-retained-control.ts';

const ACCOUNT = 'ibx_ABCDEFGHIJKLMNOP';

function document(overrides: Record<string, unknown> = {}) {
  return {
    ruleId: 'rule-test',
    version: 1,
    source: {
      channel: 'gmail',
      accountIds: [ACCOUNT],
      options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
    mapping: { subject: { $path: '/subject' }, body: { $path: '/body' } },
    targets: [{ targetId: 'local-test', version: 1, kind: 'dry-run', retentionMs: 60_000 }],
    subscribers: [],
    judges: [],
    deliveryRateCap: 1,
    retention: {
      ingestMs: 60_000,
      holdMs: 60_000,
      deliveryMs: 60_000,
      dryrunMs: 60_000,
      sseReplayMs: 60_000,
      deadLetterMs: 60_000,
      decisionMetadataMs: 60_000,
    },
    ...overrides,
  };
}

test('B3 rule test accepts only a catalogue tuple and returns a singly enveloped local result', () => {
  const result = runCatalogueRuleTest({
    document: document(),
    catalogue: { type: 'gmail.message.received', version: 1, exampleIndex: 1 },
  });
  assert.equal(result.agentic, 'not-evaluated');
  assert.equal((result.rendered.match(/<untrusted-content/g) ?? []).length, 1);
  assert.match(result.rendered, /```text/);
  assert.doesNotMatch(result.rendered, /<untrusted-content>[^\n]*<untrusted-content/u);
});

test('B3 rule test rejects retained event and account selectors before any local evaluation', () => {
  for (const catalogue of [
    { type: 'gmail.message.received', version: 1, exampleIndex: 0, eventId: 'retained-event' },
    { type: 'gmail.message.received', version: 1, exampleIndex: 0, accountId: ACCOUNT },
    { type: 'agentcomms.internal', version: 1, exampleIndex: 0 },
    { type: 'unknown.event', version: 1, exampleIndex: 0 },
  ]) {
    assert.throws(
      () => runCatalogueRuleTest({ document: document(), catalogue }),
      (error: unknown) => error instanceof EventDomainError,
    );
  }
});

test('B3 rule test never invokes a judge node while testing deterministic mapping', () => {
  const result = runCatalogueRuleTest({
    document: document({
      judges: [{ judgeId: 'judge-1', version: 1, kind: 'typesafe', provider: 'fake', model: 'fake' }],
    }),
    catalogue: { type: 'gmail.message.received', version: 1, exampleIndex: 0 },
  });
  assert.equal(result.agentic, 'not-evaluated');
});
