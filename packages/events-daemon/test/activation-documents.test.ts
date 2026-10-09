import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  type ActivationDocumentV1,
  activationDocumentDigest,
  canonicalActivationDocument,
  canonicalFullRuleDocument,
  disclosureBindingFor,
} from '../src/domain/activation-documents.ts';
import { disclosurePreviewFor } from '../src/domain/disclosure-preview.ts';

interface ActivationVector {
  readonly name: string;
  readonly intentId: string;
  readonly document: ActivationDocumentV1;
  readonly canonical: string;
  readonly digest: string;
  readonly versions: readonly { readonly kind: string; readonly id: string; readonly version: number }[];
}

async function vectors(): Promise<readonly ActivationVector[]> {
  return JSON.parse(
    await readFile(new URL('./fixtures/activation-documents-v1.json', import.meta.url), 'utf8'),
  ) as ActivationVector[];
}

test('APR-B1: each activation document has fixed v1 canonical bytes, digest and document-derived disclosure versions', async () => {
  for (const vector of await vectors()) {
    assert.equal(canonicalActivationDocument(vector.document), vector.canonical, vector.name);
    assert.equal(activationDocumentDigest(vector.document), vector.digest, vector.name);
    assert.deepEqual(disclosureBindingFor(vector.intentId, vector.document), {
      activationIntentId: vector.intentId,
      activationKind: vector.document.kind,
      digest: vector.digest,
      versions: vector.versions,
    });
  }
});

test('APR-B1: every standing-authority field mutation changes a rule document digest, while enable-all ordering does not', async () => {
  const rule = (await vectors()).find((vector) => vector.name === 'rule');
  const enableAll = (await vectors()).find((vector) => vector.name === 'enable-all');
  assert.ok(rule);
  assert.ok(enableAll);

  const mutated = (change: (document: Record<string, unknown>) => void) => {
    const document = JSON.parse(JSON.stringify(rule.document)) as Record<string, unknown>;
    change(document);
    return activationDocumentDigest(document as ActivationDocumentV1);
  };
  const original = activationDocumentDigest(rule.document);
  const changes = [
    (document: Record<string, unknown>) => {
      (document.rule as { source: { options: { labels: string[] } } }).source.options.labels[0] = 'label-other';
    },
    (document: Record<string, unknown>) => {
      (document.rule as { source: { options: Record<string, unknown> } }).source.options.labels = 'any';
    },
    (document: Record<string, unknown>) => {
      (document.rule as { source: { options: { includeSpamTrash: boolean } } }).source.options.includeSpamTrash = true;
    },
    (document: Record<string, unknown>) => {
      (document.rule as { source: { accountIds: string[] } }).source.accountIds[0] = 'account-other';
    },
    (document: Record<string, unknown>) => {
      (document.rule as { mapping: { constant: string } }).mapping.constant = 'changed';
    },
    (document: Record<string, unknown>) => {
      (document.rule as { retention: { dryrunMs: number } }).retention.dryrunMs = 3_600_000;
    },
    (document: Record<string, unknown>) => {
      const target = (document.rule as { targets: Array<{ retentionMs: number }> }).targets.at(0);
      assert.ok(target);
      target.retentionMs = 3_600_000;
    },
  ];
  for (const change of changes) assert.notEqual(mutated(change), original);

  const reordered = JSON.parse(JSON.stringify(enableAll.document)) as ActivationDocumentV1;
  assert.equal(reordered.kind, 'enable-all');
  reordered.ruleVersions = [...reordered.ruleVersions].reverse();
  assert.equal(activationDocumentDigest(reordered), activationDocumentDigest(enableAll.document));
});

test('D2/D4: canonical rule documents bind every Phase-D source option under its matching source channel', () => {
  const sources = [
    {
      channel: 'gmail',
      options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
      eventType: 'gmail.message.received',
    },
    {
      channel: 'slack',
      options: { channel: 'slack', conversations: ['C00000001'] },
      eventType: 'slack.message.posted',
    },
    {
      channel: 'resend',
      options: { channel: 'resend', kinds: ['received', 'status'] },
      eventType: 'resend.email.received',
    },
    {
      channel: 'whatsapp',
      options: { channel: 'whatsapp', chats: 'all-allowed' },
      eventType: 'whatsapp.message.received',
    },
  ] as const;
  const common = {
    ruleId: 'rule-source-variants',
    version: 1,
    event: { version: 1 },
    condition: { path: '/id', op: 'exists' },
    mapping: { constant: 'safe' },
    targets: [{ targetId: 'target-source-variants', version: 1, kind: 'dry-run', retentionMs: 86_400_000 }],
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
  for (const source of sources) {
    const canonical = canonicalFullRuleDocument({
      ...common,
      source: { channel: source.channel, accountIds: ['account-source-variants'], options: source.options },
      event: { type: source.eventType, version: 1 },
    });
    assert.deepEqual(canonical.source, {
      channel: source.channel,
      accountIds: ['account-source-variants'],
      options: source.options,
    });
  }
  assert.throws(
    () =>
      canonicalFullRuleDocument({
        ...common,
        source: {
          channel: 'slack',
          accountIds: ['account-source-variants'],
          options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
        },
        event: { type: 'slack.message.posted', version: 1 },
      }),
    /channel|source/i,
  );
});

test('APR-B1: every standalone activation authority field is bound into its digest', async () => {
  const enableAll = (await vectors()).find((vector) => vector.name === 'enable-all');
  const budget = (await vectors()).find((vector) => vector.name === 'judge-budget');
  const judgeKind = (await vectors()).find((vector) => vector.name === 'judge-kind');
  assert.ok(enableAll);
  assert.ok(budget);
  assert.ok(judgeKind);
  const original = activationDocumentDigest(enableAll.document);

  const copy = (document: ActivationDocumentV1) => JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
  const mutatedEnableAll = (change: (document: Record<string, unknown>) => void) => {
    const document = copy(enableAll.document);
    change(document);
    return activationDocumentDigest(document as ActivationDocumentV1);
  };

  assert.notEqual(
    mutatedEnableAll((document) => {
      document.switchGeneration = (document.switchGeneration as number) + 1;
    }),
    original,
  );
  assert.notEqual(
    mutatedEnableAll((document) => {
      const ruleVersions = document.ruleVersions as Array<{ ruleId: string; ruleVersion: number }>;
      const first = ruleVersions.at(0);
      assert.ok(first);
      first.ruleVersion += 1;
    }),
    original,
  );
  const budgetDocument = copy(budget.document);
  (budgetDocument.budget as { global: { callsPerRollingHour: number } }).global.callsPerRollingHour += 1;
  assert.notEqual(
    activationDocumentDigest(budgetDocument as ActivationDocumentV1),
    activationDocumentDigest(budget.document),
  );
  const judgeKindDocument = copy(judgeKind.document);
  (judgeKindDocument.enablement as { endpoint: string }).endpoint = 'http://127.0.0.1:9001';
  assert.notEqual(
    activationDocumentDigest(judgeKindDocument as ActivationDocumentV1),
    activationDocumentDigest(judgeKind.document),
  );
});

test('APR-B1: disclosure versions are derived only from the canonical document, never supplied beside it', async () => {
  const rule = (await vectors()).find((vector) => vector.name === 'rule');
  assert.ok(rule);
  const suppliedVersions = { ...rule.document, versions: [{ kind: 'judge-kind', id: 'laya', version: 1 }] };
  assert.throws(
    () => disclosureBindingFor('intent-rule', suppliedVersions as ActivationDocumentV1),
    /versions|canonical/i,
  );
});

test('APR-B1: disclosure preview carries only canonical authority data, not caller-trusted markup', async () => {
  const rule = (await vectors()).find((vector) => vector.name === 'rule');
  assert.ok(rule);
  const preview = disclosurePreviewFor(rule.intentId, rule.document);
  assert.deepEqual(preview, {
    activationIntentId: rule.intentId,
    activationKind: 'rule',
    digest: rule.digest,
    versions: rule.versions,
    canonicalDocument: rule.canonical,
  });
  assert.equal('html' in preview, false);
  assert.equal('text' in preview, false);
});

/** Every leaf of a document, as a path of keys and array indexes. */
function leafPaths(value: unknown, path: readonly (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => leafPaths(entry, [...path, index]));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => leafPaths(entry, [...path, key]));
  }
  return [[...path]];
}

function changedLeaf(value: unknown): unknown {
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'string') return `${value}-changed`;
  return 'changed';
}

test('APR-B1: no field of a rule document is dropped from its digest — each leaf changes the digest or is refused', async () => {
  const rule = (await vectors()).find((vector) => vector.name === 'rule');
  assert.ok(rule);
  const base = JSON.parse(JSON.stringify(rule.document)) as Record<string, unknown>;
  // The optional override is part of the approval when present, so the base carries one.
  (base.rule as Record<string, unknown>).cloudEventType = 'com.example.mail.received';
  const original = activationDocumentDigest(base as unknown as ActivationDocumentV1);
  const paths = leafPaths(base);
  assert.ok(paths.length > 30, 'the walk reaches the whole rule');
  for (const path of paths) {
    const document = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    let parent: Record<string | number, unknown> = document;
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
    const last = path.at(-1) as string | number;
    parent[last] = changedLeaf(parent[last]);
    let digest: string | null = null;
    try {
      digest = activationDocumentDigest(document as unknown as ActivationDocumentV1);
    } catch {
      continue; // refused: the change cannot become a different approved document
    }
    assert.notEqual(digest, original, `changing /${path.join('/')} must change the digest`);
  }
});

test('APR-B1: a rule binds its optional CloudEvent type override, and refuses an empty one', async () => {
  const rule = (await vectors()).find((vector) => vector.name === 'rule');
  assert.ok(rule);
  const withType = JSON.parse(JSON.stringify(rule.document)) as { rule: Record<string, unknown> };
  withType.rule.cloudEventType = 'com.example.mail.received';
  assert.notEqual(
    activationDocumentDigest(withType as unknown as ActivationDocumentV1),
    activationDocumentDigest(rule.document),
  );
  assert.match(
    canonicalActivationDocument(withType as unknown as ActivationDocumentV1),
    /"cloudEventType":"com\.example\.mail\.received"/,
  );
  withType.rule.cloudEventType = '';
  assert.throws(() => activationDocumentDigest(withType as unknown as ActivationDocumentV1), /cloudEventType/);
});
