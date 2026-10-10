import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { canonicalJson } from '@agentcomms/core';
import { activationDocumentDigest } from '../src/domain/activation-documents.ts';
import { verifyPendingTargetContext } from '../src/runtime/b3-pending-activation-context.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const ACCOUNT = 'ibx_ABCDEFGHIJKLMNOP';

function activation() {
  return {
    documentVersion: 1 as const,
    kind: 'rule' as const,
    rule: {
      ruleId: 'pending-rule',
      version: 2,
      source: {
        channel: 'gmail' as const,
        accountIds: [ACCOUNT],
        options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
      },
      event: { type: 'gmail.message.received', version: 1 },
      condition: { path: '/subject', op: 'exists' as const },
      mapping: { subject: { $path: '/subject' } },
      targets: [{ targetId: 'pending-target', version: 3, kind: 'dry-run' as const, retentionMs: 60_000 }],
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
    },
  };
}

test('B3 pending target context binds approval challenge to one pending activation and fixed target', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b3-pending-');
  const store = await openEventDatabase({ stateDir });
  try {
    const document = activation();
    const digest = activationDocumentDigest(document);
    store.database
      .prepare(`INSERT INTO activation_intents
        (id, kind, document, digest, effect, required_points, acquisition_scopes, status, approval_id, created_at, updated_at)
        VALUES (?, 'rule', ?, ?, '{}', '[]', '[]', 'pending', ?, 1, 1)`)
      .run('activation-1', canonicalJson(document), digest, 'approval-1');
    const selector = {
      kind: 'pending-activation' as const,
      activationId: 'activation-1',
      ruleId: 'pending-rule',
      ruleVersion: 2,
      targetId: 'pending-target',
      targetVersion: 3,
      approvalId: 'approval-1',
      digest,
      challenge: 'challenge-1',
    };
    const result = await verifyPendingTargetContext({
      database: store.database,
      selector,
      origin: 'terminal-approval',
      now: () => 1_000,
      approvalView: async () => ({ approvalId: 'approval-1', digest, challenge: 'challenge-1', expiresAt: 2_000 }),
    });
    assert.deepEqual(result, { ruleId: 'pending-rule', ruleVersion: 2, targetId: 'pending-target', targetVersion: 3 });
    await assert.rejects(
      () =>
        verifyPendingTargetContext({
          database: store.database,
          selector,
          origin: 'mcp',
          now: () => 1_000,
          approvalView: async () => ({ approvalId: 'approval-1', digest, challenge: 'challenge-1', expiresAt: 2_000 }),
        }),
      /approval-screen|terminal approval|challenge/i,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 pending target context refuses a stale challenge at the challenge binding guard', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b3-pending-stale-challenge-');
  const store = await openEventDatabase({ stateDir });
  try {
    const document = activation();
    const digest = activationDocumentDigest(document);
    store.database
      .prepare(`INSERT INTO activation_intents
        (id, kind, document, digest, effect, required_points, acquisition_scopes, status, approval_id, created_at, updated_at)
        VALUES (?, 'rule', ?, ?, '{}', '[]', '[]', 'pending', ?, 1, 1)`)
      .run('activation-1', canonicalJson(document), digest, 'approval-1');
    await assert.rejects(
      () =>
        verifyPendingTargetContext({
          database: store.database,
          selector: {
            kind: 'pending-activation',
            activationId: 'activation-1',
            ruleId: 'pending-rule',
            ruleVersion: 2,
            targetId: 'pending-target',
            targetVersion: 3,
            approvalId: 'approval-1',
            digest,
            challenge: 'challenge-1',
          },
          origin: 'terminal-approval',
          now: () => 1_000,
          approvalView: async () => ({
            approvalId: 'approval-1',
            digest,
            challenge: 'stale-challenge',
            expiresAt: 2_000,
          }),
        }),
      /challenge is stale or does not bind/i,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 pending target context refuses a digest-mismatched challenge at the challenge binding guard', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b3-pending-digest-challenge-');
  const store = await openEventDatabase({ stateDir });
  try {
    const document = activation();
    const digest = activationDocumentDigest(document);
    store.database
      .prepare(`INSERT INTO activation_intents
        (id, kind, document, digest, effect, required_points, acquisition_scopes, status, approval_id, created_at, updated_at)
        VALUES (?, 'rule', ?, ?, '{}', '[]', '[]', 'pending', ?, 1, 1)`)
      .run('activation-1', canonicalJson(document), digest, 'approval-1');
    await assert.rejects(
      () =>
        verifyPendingTargetContext({
          database: store.database,
          selector: {
            kind: 'pending-activation',
            activationId: 'activation-1',
            ruleId: 'pending-rule',
            ruleVersion: 2,
            targetId: 'pending-target',
            targetVersion: 3,
            approvalId: 'approval-1',
            digest,
            challenge: 'challenge-1',
          },
          origin: 'terminal-approval',
          now: () => 1_000,
          approvalView: async () => ({
            approvalId: 'approval-1',
            digest: 'other-digest',
            challenge: 'challenge-1',
            expiresAt: 2_000,
          }),
        }),
      /challenge is stale or does not bind/i,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 pending target context refuses an expired challenge at the challenge binding guard', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b3-pending-expired-challenge-');
  const store = await openEventDatabase({ stateDir });
  try {
    const document = activation();
    const digest = activationDocumentDigest(document);
    store.database
      .prepare(`INSERT INTO activation_intents
        (id, kind, document, digest, effect, required_points, acquisition_scopes, status, approval_id, created_at, updated_at)
        VALUES (?, 'rule', ?, ?, '{}', '[]', '[]', 'pending', ?, 1, 1)`)
      .run('activation-1', canonicalJson(document), digest, 'approval-1');
    await assert.rejects(
      () =>
        verifyPendingTargetContext({
          database: store.database,
          selector: {
            kind: 'pending-activation',
            activationId: 'activation-1',
            ruleId: 'pending-rule',
            ruleVersion: 2,
            targetId: 'pending-target',
            targetVersion: 3,
            approvalId: 'approval-1',
            digest,
            challenge: 'challenge-1',
          },
          origin: 'terminal-approval',
          now: () => 1_000,
          approvalView: async () => ({ approvalId: 'approval-1', digest, challenge: 'challenge-1', expiresAt: 1_000 }),
        }),
      /challenge is stale or does not bind/i,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 pending target context refuses a challenge bound to another approval at the challenge binding guard', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b3-pending-approval-challenge-');
  const store = await openEventDatabase({ stateDir });
  try {
    const document = activation();
    const digest = activationDocumentDigest(document);
    store.database
      .prepare(`INSERT INTO activation_intents
        (id, kind, document, digest, effect, required_points, acquisition_scopes, status, approval_id, created_at, updated_at)
        VALUES (?, 'rule', ?, ?, '{}', '[]', '[]', 'pending', ?, 1, 1)`)
      .run('activation-1', canonicalJson(document), digest, 'approval-1');
    await assert.rejects(
      () =>
        verifyPendingTargetContext({
          database: store.database,
          selector: {
            kind: 'pending-activation',
            activationId: 'activation-1',
            ruleId: 'pending-rule',
            ruleVersion: 2,
            targetId: 'pending-target',
            targetVersion: 3,
            approvalId: 'approval-1',
            digest,
            challenge: 'challenge-1',
          },
          origin: 'terminal-approval',
          now: () => 1_000,
          approvalView: async () => ({ approvalId: 'approval-2', digest, challenge: 'challenge-1', expiresAt: 2_000 }),
        }),
      /challenge is stale or does not bind/i,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
