import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalFullRuleDocument,
  canonicalJudge,
  normaliseActivationDocument,
} from '../src/domain/activation-documents.ts';
import * as judges from '../src/domain/judges.ts';
import { EventDomainError } from '../src/domain/lifecycle.ts';

const target = { targetId: 'target-e1', version: 1, kind: 'dry-run' as const, retentionMs: 86_400_000 };
const typesafeJudge = {
  judgeId: 'judge-e1',
  version: 1,
  kind: 'typesafe',
  provider: 'typesafe',
  model: 'jev-1.13.0',
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  promptTemplate: 'typesafe-jev-noul-v1',
  protocol: 'noul',
};

const agentic = {
  judge: typesafeJudge,
  question: 'Is the sender asking for a review?',
  inputs: ['/subject'],
  threshold: 0.5,
  onUncertain: 'hold',
  callsPerRollingHour: 12,
  inputTokensPerRolling30Days: 12_000,
  concurrency: 2,
  maxInputTokens: 512,
  maxOutputTokens: 64,
};

const rule = {
  ruleId: 'rule-e1',
  version: 1,
  source: {
    channel: 'gmail',
    accountIds: ['account-e1'],
    options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: { path: '/subject', op: 'contains', value: 'review' },
  mapping: { constant: 'safe' },
  targets: [target],
  subscribers: [],
  judges: [],
  deliveryRateCap: 60,
  retention: {
    ingestMs: 604_800_000,
    holdMs: 604_800_000,
    deliveryMs: 604_800_000,
    dryrunMs: 86_400_000,
    sseReplayMs: 604_800_000,
    deadLetterMs: 604_800_000,
    decisionMetadataMs: 7_776_000_000,
  },
};

test('E1: canonical rules require a deterministic condition and retain an optional agentic sibling verbatim', () => {
  const deterministic = canonicalFullRuleDocument(rule);
  assert.equal('agentic' in deterministic, false);
  assert.throws(() => canonicalFullRuleDocument({ ...rule, condition: undefined }));
  const canonical = canonicalFullRuleDocument({ ...rule, agentic });
  assert.deepEqual(canonical.agentic, agentic);
});

test('E6-M: TypeSafe documents name only concrete provider-record models, never aliases', () => {
  assert.deepEqual((judges as { readonly APPROVED_TYPESAFE_MODELS?: readonly string[] }).APPROVED_TYPESAFE_MODELS, [
    'jev-1.13.0',
  ]);
  assert.deepEqual(canonicalJudge(typesafeJudge), typesafeJudge);
  for (const model of ['jev', 'jev-latest', 'jev-preview', 'jev-99.0.0']) {
    assert.throws(
      () => canonicalJudge({ ...typesafeJudge, model }),
      (error: unknown) =>
        error instanceof EventDomainError &&
        error.code === 'VERSION_DOCUMENT_INVALID' &&
        /concrete.*provider record/i.test(error.message),
      model,
    );
  }
});

test('E1: judge documents are closed discriminated forms with a concrete local score pointer', () => {
  const local = {
    judgeId: 'judge-local-e1',
    version: 1,
    kind: 'local-endpoint',
    provider: 'ollama',
    model: 'noul',
    endpoint: 'http://127.0.0.1:11434/v1/decide',
    approvedAddressSet: ['127.0.0.1'],
    promptTemplate: 'local-noul-v1',
    protocol: 'json-score',
    scorePointer: '/score',
  };
  assert.deepEqual(canonicalJudge(local), local);
  const { scorePointer: _scorePointer, ...localNoul } = local;
  for (const malformed of [
    { ...typesafeJudge, provider: 'other' },
    { ...typesafeJudge, model: '' },
    { ...typesafeJudge, endpoint: 'https://other.example.test/' },
    { ...typesafeJudge, promptTemplate: '' },
    { ...local, protocol: 'open-score' },
    { ...localNoul, protocol: 'open-score' },
    { ...local, protocol: 'json-score', scorePointer: '/scores/*' },
    { ...local, protocol: 'json-score', scorePointer: ['/scores/0', '/scores/1'] },
    { ...local, approvedAddressSet: ['127.0.0.1', '::1'] },
  ]) {
    assert.throws(
      () => canonicalJudge(malformed),
      'each malformed judge document is refused by its closed discriminant',
    );
  }
});

test('E1: judge budgets use only the judge-budget singleton and canonical kind documents begin unavailable', () => {
  const budget = {
    budgetId: 'judge-budget',
    version: 1,
    global: { callsPerRollingHour: 20, inputTokensPerRolling30Days: 100_000, concurrency: 2 },
    providers: [{ provider: 'typesafe', callsPerRollingHour: 10, inputTokensPerRolling30Days: 50_000, concurrency: 1 }],
  };
  assert.deepEqual(normaliseActivationDocument({ documentVersion: 1, kind: 'judge-budget', budget }), {
    documentVersion: 1,
    kind: 'judge-budget',
    budget,
  });
  assert.throws(() =>
    normaliseActivationDocument({
      documentVersion: 1,
      kind: 'judge-budget',
      budget: { ...budget, budgetId: 'default' },
    }),
  );
  assert.throws(() =>
    normaliseActivationDocument({
      documentVersion: 1,
      kind: 'judge-kind',
      enablement: { kind: 'typesafe', version: 1, endpoint: 'http://127.0.0.1:11434' },
    }),
  );
  assert.equal(judges.judgeKindDefinition('laya').availability, 'unavailable');
  assert.throws(
    () =>
      normaliseActivationDocument({
        documentVersion: 1,
        kind: 'judge-kind',
        enablement: { id: 'judge-kind:laya', kind: 'laya', version: 1 },
      }),
    (error: unknown) => error instanceof EventDomainError && error.code === 'E2_EXTERNAL_REFERENCE_BLOCKED',
  );
});
