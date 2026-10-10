import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommsError, canonicalJson, sha256Hex } from '@agentcomms/core';
import {
  type ActivationDocumentV1,
  activationDocumentDigest,
  type CanonicalFullRuleDocument,
  disclosureBindingFor,
} from '../src/domain/activation-documents.ts';
import { assertDisclosable, isWhitelistedTightening } from '../src/runtime/disclosure-fence.ts';

const RULE: CanonicalFullRuleDocument & {
  readonly source: Extract<CanonicalFullRuleDocument['source'], { readonly channel: 'gmail' }>;
} = {
  ruleId: 'rule-1',
  version: 1,
  source: {
    channel: 'gmail',
    accountIds: ['account-1'],
    options: { channel: 'gmail', labels: ['Label_a', 'Label_b'], includeSpamTrash: true },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: { path: '/subject', op: 'exists' },
  mapping: { subject: { $path: '/subject' }, meta: { constant: 'safe', from: { $path: '/from/address' } } },
  targets: [
    { targetId: 'target-1', version: 1, kind: 'dry-run', retentionMs: 86_400_000 },
    { targetId: 'target-2', version: 1, kind: 'dry-run', retentionMs: 3_600_000 },
  ],
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
const ACTIVATION: ActivationDocumentV1 = { documentVersion: 1, kind: 'rule', rule: RULE };
const INTENT = 'act_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const APPROVAL = 'ap_00000000000000000000000000';
const BINDING = disclosureBindingFor(INTENT, ACTIVATION);

interface World {
  settings: { enabled: number; switch_generation: number };
  intent: Record<string, unknown>;
  rule: Record<string, unknown>;
  targets: Record<string, Record<string, unknown>>;
  revocations: Set<string>;
  approval: { form: string; record: Record<string, unknown> } | null;
  inboxes: Record<string, { id: string; provider: string }>;
}

function world(): World {
  const ruleDocument = canonicalJson(RULE);
  return {
    settings: { enabled: 1, switch_generation: 7 },
    intent: {
      id: INTENT,
      document: JSON.stringify(ACTIVATION),
      digest: activationDocumentDigest(ACTIVATION),
      kind: 'rule',
      approval_id: APPROVAL,
      status: 'completed',
      effect: '{"switchGeneration":7}',
      required_points: '[]',
    },
    rule: {
      id: 'rule-1@1',
      rule_id: 'rule-1',
      version: 1,
      document: ruleDocument,
      digest: sha256Hex(ruleDocument),
      state: 'active',
      approval_id: APPROVAL,
      authorization_activation_id: INTENT,
      revoked_at: null,
    },
    targets: Object.fromEntries(
      RULE.targets.map((target) => [
        target.targetId,
        { document: canonicalJson(target), digest: sha256Hex(canonicalJson(target)), revoked_at: null },
      ]),
    ),
    revocations: new Set(),
    approval: {
      form: 'v2',
      record: { kind: 'disclosure', state: 'used', usedAt: '2026-10-08T10:00:00.000Z', disclosure: { ...BINDING } },
    },
    inboxes: { 'events/gmail': { id: 'account-1', provider: 'gmail' } },
  };
}

function check(state: World, request: Partial<Parameters<typeof assertDisclosable>[0]> = {}) {
  const database = {
    prepare(sql: string) {
      return {
        get(...args: unknown[]) {
          if (sql.includes('event_settings')) return state.settings;
          if (sql.includes('FROM activation_intents')) return args[0] === state.intent.id ? state.intent : undefined;
          if (sql.includes('FROM rule_versions')) return state.rule;
          if (sql.includes('FROM target_versions')) return state.targets[String(args[0])];
          if (sql.includes('FROM object_revocations'))
            return state.revocations.has(`${args[0]}:${args[1]}:${args[2]}`) ? { present: 1 } : undefined;
          if (sql.includes('FROM derived_authorizations')) return undefined;
          return undefined;
        },
      };
    },
  };
  return assertDisclosable({
    database: database as never,
    approvals: { get: async () => state.approval } as never,
    config: { load: async () => ({ inboxes: state.inboxes }) } as never,
    ruleId: 'rule-1',
    ruleVersion: 1,
    targetId: 'target-1',
    targetVersion: 1,
    accountId: 'account-1',
    switchGeneration: 7,
    boundary: 'dispatch',
    ...request,
  } as never);
}

function refusedFor(reason: string, code = 'APPROVAL_VOID') {
  return (error: unknown) => {
    assert.ok(error instanceof CommsError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.details?.reason, reason);
    return true;
  };
}

test('APR-B1: the exact-activation fence passes live, bound work — and superseded work only through its lineage', async () => {
  assert.equal((await check(world())).approvalId, APPROVAL);
  const superseded = world();
  superseded.rule.state = 'superseded';
  assert.equal((await check(superseded)).authorizationActivationId, INTENT);
});

test('APR-B1: the exact-activation fence refuses every fact that no longer holds, each by its own reason', async () => {
  const cases: Array<[string, (state: World) => void, string, string?]> = [
    [
      'an approval of another kind',
      (w) => {
        w.approval = { form: 'v2', record: { ...w.approval?.record, kind: 'send' } };
      },
      'DISCLOSURE_NOT_USED',
    ],
    [
      'an approved but unclaimed approval',
      (w) => {
        w.approval = { form: 'v2', record: { ...w.approval?.record, state: 'approved' } };
      },
      'DISCLOSURE_NOT_USED',
    ],
    [
      'a missing approval',
      (w) => {
        w.approval = null;
      },
      'DISCLOSURE_NOT_USED',
    ],
    ['a used approval without usedAt', (w) => void delete w.approval?.record.usedAt, 'DISCLOSURE_BINDING_DRIFT'],
    [
      'another binding digest',
      (w) => {
        (w.approval?.record.disclosure as Record<string, unknown>).digest = 'f'.repeat(64);
      },
      'DISCLOSURE_BINDING_DRIFT',
    ],
    [
      'a reordered version list',
      (w) => {
        (w.approval?.record.disclosure as { versions: unknown[] }).versions = [...BINDING.versions].reverse();
      },
      'DISCLOSURE_BINDING_DRIFT',
    ],
    [
      'another activation kind',
      (w) => {
        w.intent.kind = 'enable-all';
      },
      'ACTIVATION_DIGEST_DRIFT',
    ],
    [
      'another document digest',
      (w) => {
        w.intent.digest = 'e'.repeat(64);
      },
      'ACTIVATION_DIGEST_DRIFT',
    ],
    [
      'an activation not completed',
      (w) => {
        w.intent.status = 'pending-completion';
      },
      'ACTIVATION_LINEAGE_MISSING',
    ],
    [
      'an activation under another approval',
      (w) => {
        w.intent.approval_id = 'ap_11111111111111111111111111';
      },
      'ACTIVATION_LINEAGE_MISSING',
    ],
    [
      'a rule version that is not the approved document',
      (w) => {
        const changed = canonicalJson({ ...RULE, deliveryRateCap: 61 });
        w.rule.document = changed;
        w.rule.digest = sha256Hex(changed);
      },
      'ACTIVATION_LINEAGE_MISMATCH',
    ],
    [
      'a rule version whose digest is wrong',
      (w) => {
        w.rule.digest = 'd'.repeat(64);
      },
      'IMMUTABLE_VERSION_DRIFT',
    ],
    [
      'a revoked rule version',
      (w) => {
        w.rule.state = 'revoked';
      },
      'RULE_REVOKED',
    ],
    [
      'a rule version with a revocation time',
      (w) => {
        w.rule.revoked_at = 5;
      },
      'RULE_REVOKED',
    ],
    [
      'an inert rule version',
      (w) => {
        w.rule.state = null;
      },
      'RULE_LIFECYCLE',
    ],
    [
      'a target version that drifted',
      (w) => {
        (w.targets['target-2'] as Record<string, unknown>).document = canonicalJson({
          ...RULE.targets[1],
          retentionMs: 1,
        });
      },
      'IMMUTABLE_VERSION_DRIFT',
    ],
    [
      'a revoked target row',
      (w) => {
        (w.targets['target-2'] as Record<string, unknown>).revoked_at = 9;
      },
      'BOUND_OBJECT_REVOKED',
    ],
    ['an object revocation', (w) => void w.revocations.add('target:target-1:1'), 'BOUND_OBJECT_REVOKED'],
    [
      'a disabled switch',
      (w) => {
        w.settings.enabled = 0;
      },
      'STALE_GENERATION',
    ],
    [
      'a newer switch generation',
      (w) => {
        w.settings.switch_generation = 8;
      },
      'STALE_GENERATION',
    ],
    [
      'a removed account',
      (w) => {
        w.inboxes = {};
      },
      'ACCOUNT_REMOVED',
      'NOT_FOUND',
    ],
  ];
  for (const [name, change, reason, code] of cases) {
    const state = world();
    change(state);
    await assert.rejects(check(state), refusedFor(reason, code), name);
  }
  await assert.rejects(
    check(world(), { accountId: 'account-2' }),
    refusedFor('ACCOUNT_NOT_BOUND'),
    'an unbound account',
  );
  await assert.rejects(
    check(world(), { targetVersion: 2 }),
    refusedFor('BOUND_OBJECT_REVOKED'),
    'an unbound target version',
  );
});

function variant(
  change: (rule: { -readonly [K in keyof CanonicalFullRuleDocument]: CanonicalFullRuleDocument[K] }) => void,
) {
  const rule = JSON.parse(JSON.stringify(RULE)) as CanonicalFullRuleDocument & Record<string, unknown>;
  (rule as { version: number }).version = 2;
  change(rule as never);
  return rule;
}

test('APR-B1: each whitelisted tightening changes only its own field, strictly narrower', () => {
  const allowed: Array<[string, CanonicalFullRuleDocument]> = [
    [
      'remove-target',
      variant((r) => {
        r.targets = [RULE.targets[0] as never];
      }),
    ],
    [
      'remove-output-field',
      variant((r) => {
        r.mapping = { subject: { $path: '/subject' } };
      }),
    ],
    [
      'remove-output-field',
      variant((r) => {
        r.mapping = { subject: { $path: '/subject' }, meta: { constant: 'safe' } };
      }),
    ],
    [
      'lower-rate-cap',
      variant((r) => {
        r.deliveryRateCap = 30;
      }),
    ],
    [
      'shorten-retention',
      variant((r) => {
        r.retention = { ...RULE.retention, deliveryMs: 86_400_000 };
      }),
    ],
    [
      'narrow-source-options',
      variant((r) => {
        r.source = {
          ...RULE.source,
          options: { channel: 'gmail', labels: ['Label_a'], includeSpamTrash: true },
        };
      }),
    ],
    [
      'narrow-source-options',
      variant((r) => {
        r.source = {
          ...RULE.source,
          options: { channel: 'gmail', labels: ['Label_a', 'Label_b'], includeSpamTrash: false },
        };
      }),
    ],
  ];
  for (const [kind, child] of allowed)
    assert.equal(isWhitelistedTightening(RULE, child, kind), true, `${kind} is a tightening`);
});

test('APR-B1: an edge that loosens, changes anything besides its own field, or is no change at all is refused', () => {
  const refused: Array<[string, string, CanonicalFullRuleDocument]> = [
    [
      'a source loosening',
      'narrow-source-options',
      variant((r) => {
        r.source = { ...RULE.source, options: { channel: 'gmail', labels: 'any', includeSpamTrash: true } };
      }),
    ],
    [
      'a mixed source edit',
      'narrow-source-options',
      variant((r) => {
        r.source = {
          ...RULE.source,
          options: { channel: 'gmail', labels: ['Label_a', 'Label_c'], includeSpamTrash: true },
        };
      }),
    ],
    [
      'an added account',
      'narrow-source-options',
      variant((r) => {
        r.source = {
          ...RULE.source,
          accountIds: ['account-1', 'account-2'],
          options: { channel: 'gmail', labels: ['Label_a'], includeSpamTrash: true },
        };
      }),
    ],
    [
      'a lower cap that also adds a field',
      'lower-rate-cap',
      variant((r) => {
        r.deliveryRateCap = 30;
        r.mapping = { ...(RULE.mapping as object), body: { $path: '/body' } };
      }),
    ],
    [
      'a lower cap that also loosens the source',
      'lower-rate-cap',
      variant((r) => {
        r.deliveryRateCap = 30;
        r.source = { ...RULE.source, options: { channel: 'gmail', labels: 'any', includeSpamTrash: true } };
      }),
    ],
    [
      'a raised cap',
      'lower-rate-cap',
      variant((r) => {
        r.deliveryRateCap = 61;
      }),
    ],
    [
      'a retention shortened and another lengthened',
      'shorten-retention',
      variant((r) => {
        r.retention = { ...RULE.retention, deliveryMs: 86_400_000, deadLetterMs: 1_209_600_000 };
      }),
    ],
    [
      'a shorter retention with a new cloudEventType',
      'shorten-retention',
      variant((r) => {
        r.retention = { ...RULE.retention, deliveryMs: 86_400_000 };
        (r as Record<string, unknown>).cloudEventType = 'com.example.other';
      }),
    ],
    [
      'a mapping value changed, not removed',
      'remove-output-field',
      variant((r) => {
        r.mapping = { subject: { $path: '/snippet' } };
      }),
    ],
    [
      'a reference narrowed inside',
      'remove-output-field',
      variant((r) => {
        r.mapping = { ...(RULE.mapping as object), subject: { $path: '/subject', missing: 'null' } };
      }),
    ],
    [
      'an added target',
      'remove-target',
      variant((r) => {
        r.targets = [...RULE.targets, { targetId: 'target-3', version: 1, kind: 'dry-run', retentionMs: 1 }];
      }),
    ],
    [
      'a target swapped for another',
      'remove-target',
      variant((r) => {
        r.targets = [{ ...RULE.targets[0], retentionMs: 1 } as never];
      }),
    ],
    [
      'a target removal that also changes a condition',
      'remove-target',
      variant((r) => {
        r.targets = [RULE.targets[0] as never];
        r.condition = { path: '/from/address', op: 'exists' } as never;
      }),
    ],
    ['an unchanged rule', 'lower-rate-cap', variant(() => undefined)],
    [
      'an unknown edit kind',
      'raise-everything',
      variant((r) => {
        r.deliveryRateCap = 1;
      }),
    ],
  ];
  for (const [name, kind, child] of refused) assert.equal(isWhitelistedTightening(RULE, child, kind), false, name);
  assert.equal(isWhitelistedTightening(RULE, { ...RULE, deliveryRateCap: 1 }, 'lower-rate-cap'), false, 'same version');
});

/** A derived lineage: rule-1@2 lowers the cap of the exactly activated rule-1@1, which the tightening revoked. */
function derivedWorld() {
  const base = world();
  const child = { ...RULE, version: 2, deliveryRateCap: 30 };
  const childDocument = canonicalJson(child);
  const rows: Record<string, Record<string, unknown>> = {
    'rule-1@1': { ...base.rule, state: 'revoked', revoked_at: null },
    'rule-1@2': {
      id: 'rule-1@2',
      rule_id: 'rule-1',
      version: 2,
      document: childDocument,
      digest: sha256Hex(childDocument),
      state: 'active',
      approval_id: APPROVAL,
      authorization_activation_id: 'rule-1@2',
      revoked_at: null,
    },
  };
  const edges: Record<string, Record<string, unknown>> = {
    'rule-1@2': { parent_approval_id: APPROVAL, parent_version_id: 'rule-1@1', edit_kind: 'lower-rate-cap' },
  };
  return { base, rows, edges };
}

function checkDerived(state: ReturnType<typeof derivedWorld>) {
  const database = {
    prepare(sql: string) {
      return {
        get(...args: unknown[]) {
          if (sql.includes('event_settings')) return state.base.settings;
          if (sql.includes('FROM activation_intents'))
            return args[0] === state.base.intent.id ? state.base.intent : undefined;
          if (sql.includes('FROM rule_versions WHERE id = ?')) return state.rows[String(args[0])];
          if (sql.includes('FROM rule_versions')) return state.rows[`${args[0]}@${args[1]}`];
          if (sql.includes('FROM target_versions')) return state.base.targets[String(args[0])];
          if (sql.includes('FROM derived_authorizations')) return state.edges[String(args[0])];
          return undefined;
        },
      };
    },
  };
  return assertDisclosable({
    database: database as never,
    approvals: { get: async () => state.base.approval } as never,
    config: { load: async () => ({ inboxes: state.base.inboxes }) } as never,
    ruleId: 'rule-1',
    ruleVersion: 2,
    accountId: 'account-1',
    switchGeneration: 7,
    boundary: 'source',
  });
}

test('APR-B1: a derived tightening is disclosable only through a valid edge to the exact activation', async () => {
  const valid = await checkDerived(derivedWorld());
  assert.equal(valid.approvalId, APPROVAL);
  assert.equal(valid.authorizationActivationId, INTENT, 'the lineage ends at the exact activation');

  const cases: Array<[string, (state: ReturnType<typeof derivedWorld>) => void, string]> = [
    [
      'a derived row naming another lineage id',
      (s) => {
        (s.rows['rule-1@2'] as Record<string, unknown>).authorization_activation_id = INTENT.replace('Z', 'Y');
      },
      'DERIVATION_EDGE_INVALID',
    ],
    [
      'a derived row under another approval',
      (s) => {
        (s.rows['rule-1@2'] as Record<string, unknown>).approval_id = 'ap_11111111111111111111111111';
      },
      'DERIVATION_EDGE_INVALID',
    ],
    [
      'an edge under another approval',
      (s) => {
        (s.edges['rule-1@2'] as Record<string, unknown>).parent_approval_id = 'ap_11111111111111111111111111';
      },
      'DERIVATION_EDGE_INVALID',
    ],
    ['no edge', (s) => void delete s.edges['rule-1@2'], 'DERIVATION_EDGE_INVALID'],
    [
      'an edge to a later parent',
      (s) => {
        (s.rows['rule-1@1'] as Record<string, unknown>).version = 3;
      },
      'DERIVATION_PARENT_INVALID',
    ],
    [
      'an edge that is not a tightening',
      (s) => {
        (s.edges['rule-1@2'] as Record<string, unknown>).edit_kind = 'shorten-retention';
      },
      'DERIVATION_NOT_TIGHTENING',
    ],
  ];
  for (const [name, change, reason] of cases) {
    const state = derivedWorld();
    change(state);
    await assert.rejects(checkDerived(state), refusedFor(reason), name);
  }
});
