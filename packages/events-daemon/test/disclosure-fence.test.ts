import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import {
  type ActivationDocumentV1,
  activationDocumentDigest,
  disclosureBindingFor,
} from '../src/domain/activation-documents.ts';
import { assertDisclosable, isWhitelistedTightening } from '../src/runtime/disclosure-fence.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

test('APR-B1: the live disclosure fence reads immutable lifecycle, approval binding, object revocation, account and generation at call time', {
  skip: WINDOWS_SKIP,
}, async () => {
  const activation: ActivationDocumentV1 = {
    documentVersion: 1,
    kind: 'rule',
    rule: {
      ruleId: 'rule-1',
      version: 1,
      source: {
        channel: 'gmail',
        accountIds: ['account-1'],
        options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
      },
      event: { type: 'gmail.message.received', version: 1 },
      condition: { path: '/subject', op: 'exists' },
      mapping: { constant: 'safe' },
      targets: [{ targetId: 'target-1', version: 1, kind: 'dry-run', retentionMs: 86_400_000 }],
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
    },
  };
  const intentId = 'act_01HZZZZZZZZZZZZZZZZZZZZZZZ';
  const binding = disclosureBindingFor(intentId, activation);
  const reads = new Map<string, number>();
  const database = {
    prepare(sql: string) {
      return {
        get(...args: unknown[]) {
          const key = `${sql}:${args.join(':')}`;
          reads.set(key, (reads.get(key) ?? 0) + 1);
          if (sql.includes('event_settings')) return { enabled: 1, switch_generation: 7 };
          if (sql.includes('activation_intents'))
            return {
              id: intentId,
              document: JSON.stringify(activation),
              digest: activationDocumentDigest(activation),
              kind: 'rule',
              approval_id: 'ap_00000000000000000000000000',
              status: 'completed',
              effect: '{"switchGeneration":7}',
            };
          if (sql.includes('rule_versions')) {
            return {
              document: canonicalJson(activation.rule),
              id: 'rule-1@1',
              rule_id: 'rule-1',
              version: 1,
              digest: sha256Hex(canonicalJson(activation.rule)),
              state: 'active',
              approval_id: 'ap_00000000000000000000000000',
              authorization_activation_id: intentId,
              revoked_at: null,
            };
          }
          if (sql.includes('target_versions'))
            return {
              document: canonicalJson(activation.rule.targets[0]),
              digest: sha256Hex(canonicalJson(activation.rule.targets[0])),
              revoked_at: null,
            };
          if (sql.includes('object_revocations')) return undefined;
          return undefined;
        },
      };
    },
  };
  const approval = {
    form: 'v2' as const,
    record: {
      kind: 'disclosure' as const,
      state: 'used' as const,
      usedAt: '2026-10-08T10:00:00.000Z',
      disclosure: {
        activationIntentId: intentId,
        activationKind: 'rule' as const,
        digest: binding.digest,
        versions: binding.versions,
      },
    },
  };
  const snapshot = await assertDisclosable({
    database: database as never,
    approvals: { get: async () => approval } as never,
    config: { load: async () => ({ inboxes: { event: { id: 'account-1', provider: 'gmail' } } }) } as never,
    ruleId: 'rule-1',
    ruleVersion: 1,
    targetId: 'target-1',
    targetVersion: 1,
    accountId: 'account-1',
    switchGeneration: 7,
    boundary: 'recovery',
  });
  assert.deepEqual(snapshot, {
    approvalId: 'ap_00000000000000000000000000',
    authorizationActivationId: intentId,
    usedAt: '2026-10-08T10:00:00.000Z',
    switchGeneration: 7,
  });
  assert.ok(reads.size >= 5, 'each live fact is queried rather than accepted from a cached pointer or lifecycle input');
});

test('D2/D4: source-option derivation delegates to the four-channel dispatcher and refuses additions', () => {
  const rule = (source: unknown, version: number) =>
    ({
      ruleId: 'rule-source-tightening',
      version,
      source: { channel: (source as { channel: string }).channel, accountIds: ['account-1'], options: source },
      event: { type: 'slack.message.posted', version: 1 },
      condition: { path: '/id', op: 'exists' },
      mapping: { constant: 'safe' },
      targets: [],
      subscribers: [],
      judges: [],
      deliveryRateCap: 1,
      retention: {
        ingestMs: 1,
        holdMs: 1,
        deliveryMs: 1,
        dryrunMs: 1,
        sseReplayMs: 1,
        deadLetterMs: 1,
        decisionMetadataMs: 1,
      },
    }) as never;
  const variants: ReadonlyArray<readonly [unknown, unknown, boolean]> = [
    [
      { channel: 'slack', conversations: ['C00000001', 'C00000002'] },
      { channel: 'slack', conversations: ['C00000001'] },
      true,
    ],
    [{ channel: 'resend', kinds: ['received', 'status'] }, { channel: 'resend', kinds: ['status'] }, true],
    [
      { channel: 'whatsapp', chats: 'all-allowed' },
      { channel: 'whatsapp', chats: ['15550000001@s.whatsapp.net'] },
      true,
    ],
    [
      { channel: 'slack', conversations: ['C00000001'] },
      { channel: 'slack', conversations: ['C00000001', 'C00000002'] },
      false,
    ],
  ];
  for (const [before, after, expected] of variants) {
    assert.equal(isWhitelistedTightening(rule(before, 1), rule(after, 2), 'narrow-source-options'), expected);
  }
});
