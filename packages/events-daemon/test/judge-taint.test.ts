import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { TaintStore } from '@agentcomms/core';
import { gmailMessageReceivedV1 } from '@agentcomms/events';
import { buildJudgeInput } from '../src/runtime/judge-coordinator.ts';
import { recordEventTaint } from '../src/runtime/untrusted.ts';
import { shortTempDir } from './support/short-temp.ts';

test('E7 taint: exact judge input preserves copied scalar, parent and subtree provenance while constants inherit none', async () => {
  const event = {
    ...gmailMessageReceivedV1.examples[1],
    account: { name: 'Fixture', id: 'ibx_E7TAINTFIXTURE', channel: 'gmail' as const },
    subject: 'from sender@example.test',
    from: { address: 'sender@example.test', name: 'Synthetic Sender' },
    body: 'please reply to body@example.test',
  };
  const input = buildJudgeInput(
    {
      ruleId: 'rule-e7-taint',
      version: 1,
      source: {
        channel: 'gmail',
        accountIds: ['ibx_E7TAINTFIXTURE'],
        options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
      },
      event: { type: 'gmail.message.received', version: 1 },
      condition: { path: '/subject', op: 'exists' },
      agentic: {
        judge: {
          judgeId: 'judge-e7-taint',
          version: 1,
          kind: 'local-endpoint',
          provider: 'ollama',
          model: 'nimble',
          endpoint: 'http://127.0.0.1:11434/v1/systemone',
          approvedAddressSet: ['127.0.0.1'],
          promptTemplate: 'ollama-noul-v1',
          protocol: 'noul',
        },
        question: 'synthetic',
        inputs: ['/subject', '/from', '/body'],
        threshold: 0.5,
        onUncertain: 'no-match',
        callsPerRollingHour: 1,
        inputTokensPerRolling30Days: 1_000,
        concurrency: 1,
        maxInputTokens: 1_000,
        maxOutputTokens: 10,
      },
      mapping: { safe: true },
      targets: [{ targetId: 'dry-e7-taint', version: 1, kind: 'dry-run', retentionMs: 1_000 }],
      subscribers: [],
      judges: [],
      deliveryRateCap: 1,
      retention: {
        ingestMs: 1_000,
        holdMs: 1_000,
        deliveryMs: 1_000,
        dryrunMs: 1_000,
        sseReplayMs: 1_000,
        deadLetterMs: 1_000,
        decisionMetadataMs: 1_000,
      },
    },
    event,
  );
  assert.ok(input);
  assert.equal(input.classification.addresses.length, 1);
  assert.equal(input.classification.addresses[0]?.address, 'sender@example.test');
  assert.equal(input.classification.addresses[0]?.pointer, '/inputs/1/value/address');
  assert.equal(
    input.classification.untrusted.some((entry) => entry.text === 'Synthetic Sender'),
    true,
  );
  assert.equal(
    input.classification.untrusted.some((entry) => entry.text === 'from sender@example.test'),
    true,
  );
  assert.equal(
    input.classification.untrusted.some((entry) => entry.text === 'please reply to body@example.test'),
    true,
  );
  assert.equal(
    input.classification.untrusted.every((entry) => entry.pointer.startsWith('/inputs/')),
    true,
  );
  const state = JSON.parse(input.state) as { version: number; inputs: readonly { pointer: string; value: unknown }[] };
  assert.equal(state.version, 1, 'the envelope version is a constant, not a copied source value');
  assert.deepEqual(
    state.inputs.map((entry) => entry.pointer),
    ['/subject', '/from', '/body'],
  );

  const stateDir = await shortTempDir('events-e7-taint-');
  try {
    const taint = new TaintStore(stateDir);
    await recordEventTaint(
      taint,
      { ownAddresses: [], internalDomains: [] },
      {
        eventId: 'e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7',
        accountId: 'ibx_E7TAINTFIXTURE',
        classification: input.classification,
      },
    );
    const header = await taint.check('sender@example.test');
    const body = await taint.check('body@example.test');
    assert.equal(header.addressSeen?.source, 'header');
    assert.equal(header.addressSeen?.origins.includes('event'), true);
    assert.equal(body.addressSeen?.source, 'body');
    assert.equal(body.addressSeen?.origins.includes('event'), true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
