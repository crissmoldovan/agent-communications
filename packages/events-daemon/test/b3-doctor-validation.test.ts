import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import {
  activationDocumentDigest,
  type CanonicalFullRuleDocument,
  canonicalFullRuleDocument,
  disclosureBindingFor,
} from '../src/domain/activation-documents.ts';
import { projectB3Doctor } from '../src/runtime/b3-doctor-projection.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const ACCOUNT = 'ibx_DOCTORVALIDATION';
const APPROVAL = 'approval-doctor-validation';
const ROOT_INTENT = 'activation-doctor-validation';

function rule(ruleId: string, version: number, deliveryRateCap: number): CanonicalFullRuleDocument {
  return canonicalFullRuleDocument({
    ruleId,
    version,
    source: {
      channel: 'gmail',
      accountIds: [ACCOUNT],
      options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
    mapping: { constant: 'doctor-safe' },
    targets: [{ targetId: 'target-doctor-validation', version: 1, kind: 'dry-run', retentionMs: 60_000 }],
    subscribers: [],
    judges: [],
    deliveryRateCap,
    retention: {
      ingestMs: 60_000,
      holdMs: 60_000,
      deliveryMs: 60_000,
      dryrunMs: 60_000,
      sseReplayMs: 60_000,
      deadLetterMs: 60_000,
      decisionMetadataMs: 60_000,
    },
  });
}

function insertRule(
  database: Awaited<ReturnType<typeof openEventDatabase>>['database'],
  value: CanonicalFullRuleDocument,
  input: {
    readonly state?: 'active' | 'superseded';
    readonly authorizationActivationId: string;
    readonly digest?: string;
  },
): void {
  const document = canonicalJson(value);
  database
    .prepare(
      `INSERT INTO rule_versions
       (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at, superseded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 10, ?)`,
    )
    .run(
      `${value.ruleId}@${value.version}`,
      value.ruleId,
      value.version,
      document,
      input.digest ?? sha256Hex(document),
      input.state ?? 'superseded',
      APPROVAL,
      input.authorizationActivationId,
      input.state === 'active' ? null : 20,
    );
}

async function fixture() {
  const stateDir = await shortTempDir('aev-b3-doctor-validation-');
  const store = await openEventDatabase({ stateDir });
  const target = canonicalJson({
    targetId: 'target-doctor-validation',
    version: 1,
    kind: 'dry-run',
    retentionMs: 60_000,
  });
  store.database
    .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
    .run('target-doctor-validation@1', 'target-doctor-validation', target, sha256Hex(target));
  return { stateDir, store };
}

function active(
  database: Awaited<ReturnType<typeof openEventDatabase>>['database'],
  ruleId: string,
  version: number,
): void {
  database
    .prepare(
      `INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
       VALUES ('rule', ?, ?, 'doctor-current-cutover', 10)`,
    )
    .run(ruleId, version);
}

function completedRoot(
  database: Awaited<ReturnType<typeof openEventDatabase>>['database'],
  root: CanonicalFullRuleDocument,
  status: 'completed' | 'pending' = 'completed',
) {
  const activation = { documentVersion: 1 as const, kind: 'rule' as const, rule: root };
  database
    .prepare(
      `INSERT INTO activation_intents
       (id, kind, document, digest, approval_id, effect, required_points, acquisition_scopes, status, created_at, updated_at)
       VALUES (?, 'rule', ?, ?, ?, '{}', '[]', '[]', ?, 10, 10)`,
    )
    .run(ROOT_INTENT, canonicalJson(activation), activationDocumentDigest(activation), APPROVAL, status);
  return {
    get: async () => ({
      form: 'v2' as const,
      record: {
        kind: 'disclosure' as const,
        state: 'used' as const,
        usedAt: '2026-10-11T00:00:00.000Z',
        disclosure: disclosureBindingFor(ROOT_INTENT, activation),
      },
    }),
  };
}

async function doctor(
  store: Awaited<ReturnType<typeof openEventDatabase>>,
  approvals: { readonly get: () => Promise<unknown> },
  now = 1_000,
) {
  return projectB3Doctor({
    database: store.database,
    installationId: store.installationId,
    lifecycle: { enabled: true, paused: false, switchGeneration: 1 },
    protocolVersions: [1],
    ports: { assertObjectSecretReady: async () => undefined } as never,
    config: { load: async () => ({ inboxes: {}, accounts: {} }) } as never,
    now: () => now,
    approvals,
    decryptSourceState: async (stored: Uint8Array) => JSON.parse(Buffer.from(stored).toString('utf8')),
  } as never);
}

test('B3 doctor validates a complete v1 to v2 to v3 derived lineage with exact stable edges', {
  skip: WINDOWS_SKIP,
}, async () => {
  const { stateDir, store } = await fixture();
  try {
    const ruleId = 'rule-doctor-valid';
    const v1 = rule(ruleId, 1, 3);
    const v2 = rule(ruleId, 2, 2);
    const v3 = rule(ruleId, 3, 1);
    insertRule(store.database, v1, { authorizationActivationId: ROOT_INTENT });
    insertRule(store.database, v2, { authorizationActivationId: `${ruleId}@2` });
    insertRule(store.database, v3, { state: 'active', authorizationActivationId: `${ruleId}@3` });
    const approvals = completedRoot(store.database, v1);
    const edges: readonly (readonly [string, string])[] = [
      [`${ruleId}@2`, `${ruleId}@1`],
      [`${ruleId}@3`, `${ruleId}@2`],
    ];
    for (const [versionId, parentVersionId] of edges)
      store.database
        .prepare(
          `INSERT INTO derived_authorizations (version_id, parent_approval_id, parent_version_id, edit_kind, created_at)
           VALUES (?, ?, ?, 'lower-rate-cap', 10)`,
        )
        .run(versionId, APPROVAL, parentVersionId);
    active(store.database, ruleId, 3);

    const report = await doctor(store, approvals);
    const lineage = report.lineages[0] as unknown as {
      readonly validation?: unknown;
      readonly derivation: unknown;
    };
    assert.deepEqual(lineage.validation, { status: 'valid' });
    assert.deepEqual(lineage.derivation, [
      {
        versionId: `${ruleId}@2`,
        parentApprovalId: APPROVAL,
        parentVersionId: `${ruleId}@1`,
        editKind: 'lower-rate-cap',
      },
      {
        versionId: `${ruleId}@3`,
        parentApprovalId: APPROVAL,
        parentVersionId: `${ruleId}@2`,
        editKind: 'lower-rate-cap',
      },
    ]);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 doctor gives each malformed active lineage its stable shared-validator code', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const cases = [
    { name: 'missing completed root', code: 'ACTIVATION_LINEAGE_MISSING' },
    { name: 'wrong root approval', code: 'DERIVATION_ROOT_INVALID' },
    { name: 'missing edge', code: 'DERIVATION_EDGE_INVALID' },
    { name: 'wrong-rule parent', code: 'DERIVATION_PARENT_INVALID' },
    { name: 'wrong edit kind', code: 'DERIVATION_NOT_TIGHTENING' },
    { name: 'digest mismatch', code: 'IMMUTABLE_VERSION_DRIFT' },
    { name: 'cycle', code: 'DERIVATION_CYCLE' },
  ] as const;
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { stateDir, store } = await fixture();
      try {
        const ruleId = `rule-doctor-invalid-${scenario.name.replaceAll(' ', '-')}`;
        const v1 = rule(ruleId, 1, 3);
        const v2 = rule(ruleId, 2, 2);
        insertRule(store.database, v1, { authorizationActivationId: ROOT_INTENT });
        insertRule(store.database, v2, {
          state: 'active',
          authorizationActivationId: `${ruleId}@2`,
          ...(scenario.name === 'digest mismatch' ? { digest: '0'.repeat(64) } : {}),
        });
        const approvals = completedRoot(
          store.database,
          scenario.name === 'wrong root approval' ? rule(ruleId, 1, 4) : v1,
          scenario.name === 'missing completed root' ? 'pending' : 'completed',
        );
        if (scenario.name !== 'missing edge' && scenario.name !== 'cycle') {
          let parentVersionId = `${ruleId}@1`;
          if (scenario.name === 'wrong-rule parent') {
            const other = rule('rule-doctor-wrong-parent', 1, 3);
            insertRule(store.database, other, { authorizationActivationId: ROOT_INTENT });
            parentVersionId = `${other.ruleId}@${other.version}`;
          }
          store.database
            .prepare(
              `INSERT INTO derived_authorizations (version_id, parent_approval_id, parent_version_id, edit_kind, created_at)
               VALUES (?, ?, ?, ?, 10)`,
            )
            .run(
              `${ruleId}@2`,
              APPROVAL,
              parentVersionId,
              scenario.name === 'wrong edit kind' ? 'unrecognised-edit-kind' : 'lower-rate-cap',
            );
        }
        if (scenario.name === 'cycle') {
          store.database
            .prepare(
              `INSERT INTO derived_authorizations (version_id, parent_approval_id, parent_version_id, edit_kind, created_at)
               VALUES (?, ?, ?, 'lower-rate-cap', 10)`,
            )
            .run(`${ruleId}@2`, APPROVAL, `${ruleId}@1`);
          store.database
            .prepare(
              `INSERT INTO derived_authorizations (version_id, parent_approval_id, parent_version_id, edit_kind, created_at)
               VALUES (?, ?, ?, 'lower-rate-cap', 10)`,
            )
            .run(`${ruleId}@1`, APPROVAL, `${ruleId}@2`);
          store.database
            .prepare('UPDATE rule_versions SET authorization_activation_id = ? WHERE id = ?')
            .run(`${ruleId}@1`, `${ruleId}@1`);
        }
        active(store.database, ruleId, 2);

        const report = await doctor(store, approvals);
        const lineage = report.lineages[0] as unknown as {
          readonly validation?: unknown;
          readonly derivation: unknown;
        };
        assert.deepEqual(lineage.validation, { status: 'invalid', code: scenario.code });
        assert.deepEqual(lineage.derivation, [], 'invalid edges are never serialised as an unknown edit kind');
      } finally {
        store.close();
        await rm(stateDir, { recursive: true, force: true });
      }
    });
  }
});

test('B3 doctor refuses a used root that does not approve the exact parent rule', { skip: WINDOWS_SKIP }, async () => {
  const { stateDir, store } = await fixture();
  try {
    const ruleId = 'rule-doctor-root-approval';
    const v1 = rule(ruleId, 1, 3);
    const v2 = rule(ruleId, 2, 2);
    insertRule(store.database, v1, { authorizationActivationId: ROOT_INTENT });
    insertRule(store.database, v2, { state: 'active', authorizationActivationId: `${ruleId}@2` });
    store.database
      .prepare(
        `INSERT INTO derived_authorizations (version_id, parent_approval_id, parent_version_id, edit_kind, created_at)
         VALUES (?, ?, ?, 'lower-rate-cap', 10)`,
      )
      .run(`${ruleId}@2`, APPROVAL, `${ruleId}@1`);
    active(store.database, ruleId, 2);

    const report = await doctor(store, completedRoot(store.database, rule(ruleId, 1, 4)));
    assert.deepEqual((report.lineages[0] as unknown as { readonly validation: unknown }).validation, {
      status: 'invalid',
      code: 'DERIVATION_ROOT_INVALID',
    });
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 doctor reads retry age, occurrence count, and maximum attempts from pending encrypted state', {
  skip: WINDOWS_SKIP,
}, async () => {
  const { stateDir, store } = await fixture();
  try {
    const gmail = 'ibx_DOCTORMETADATA';
    const materialisation = 'ibx_DOCTORMATERIALISATION';
    const resend = 'acc_DOCTORRESEND';
    const latestFailure = 'ibx_DOCTORLATESTFAILURE';
    const staged = (value: unknown) => Buffer.from(JSON.stringify(value));
    store.database
      .prepare(
        `INSERT INTO source_scan_state (id, source, account_id, cursor_scope, encrypted_record, updated_at)
         VALUES ('gmail-metadata', 'gmail', ?, 'mailbox', ?, 200)`,
      )
      .run(gmail, staged({ messageStates: { occurrence: { firstFailedAt: 100, attempts: 2, nextRetryAt: 300 } } }));
    store.database
      .prepare(
        `INSERT INTO source_scan_state (id, source, account_id, cursor_scope, encrypted_record, updated_at)
         VALUES ('gmail-materialisation', 'gmail', ?, 'materialisation', ?, 200)`,
      )
      .run(materialisation, staged({ first_failed_at: 100, attempts: 2, next_retry_at: 300 }));
    store.database
      .prepare(
        `INSERT INTO source_scan_state (id, source, account_id, cursor_scope, encrypted_record, updated_at)
         VALUES ('resend-received', 'resend', ?, 'received', ?, 200)`,
      )
      .run(resend, staged({ retry: { firstFailedAt: 100, attempts: 2, nextRetryAt: 300 } }));
    store.database
      .prepare(
        `INSERT INTO source_scan_state (id, source, account_id, cursor_scope, encrypted_record, updated_at)
         VALUES ('gmail-earliest-failure', 'gmail', ?, 'mailbox', ?, 200)`,
      )
      .run(
        latestFailure,
        staged({
          messageStates: {
            first: { firstFailedAt: 100, attempts: 2, nextRetryAt: 300 },
            later: { firstFailedAt: 200, attempts: 1, nextRetryAt: 300 },
          },
        }),
      );

    const report = await doctor(store, { get: async () => null }, 400);
    const health = new Map(report.sources.map((source) => [`${source.source}\u0000${source.accountId}`, source]));
    assert.deepEqual((health.get(`gmail\u0000${gmail}`) as unknown as { metadata: unknown }).metadata, {
      retryAgeMs: 300,
      retryCount: 1,
      maxAttempts: 2,
      unreadable: 0,
      resolutions: { vanished: 0, unresolvable: 0, retentionExpired: 0, last: null },
    });
    assert.deepEqual(
      (health.get(`gmail\u0000${materialisation}`) as unknown as { materialisation: unknown }).materialisation,
      {
        retryAgeMs: 300,
        retryCount: 1,
        maxAttempts: 2,
        unreadable: 0,
        resolutions: { vanished: 0, unresolvable: 0, retentionExpired: 0, last: null },
      },
    );
    assert.deepEqual((health.get(`resend\u0000${resend}`) as unknown as { materialisation: unknown }).materialisation, {
      retryAgeMs: 300,
      retryCount: 1,
      maxAttempts: 2,
      unreadable: 0,
      resolutions: { vanished: 0, unresolvable: 0, retentionExpired: 0, last: null },
    });
    assert.deepEqual((health.get(`gmail\u0000${latestFailure}`) as unknown as { metadata: unknown }).metadata, {
      retryAgeMs: 300,
      retryCount: 2,
      maxAttempts: 2,
      unreadable: 0,
      resolutions: { vanished: 0, unresolvable: 0, retentionExpired: 0, last: null },
    });

    store.database.prepare("DELETE FROM source_scan_state WHERE source = 'gmail'").run();
    store.database
      .prepare(
        `INSERT INTO source_occurrence_resolutions (source, account_id, occurrence_key, outcome, resolved_at)
         VALUES ('gmail', ?, 'metadata-terminal', 'unresolvable', 350)`,
      )
      .run(gmail);
    store.database
      .prepare(
        `INSERT INTO source_projection_resolutions
         (source, account_id, occurrence_key, rule_id, rule_version, materialization_key, outcome, resolved_at)
         VALUES ('gmail', ?, 'materialisation-terminal', 'rule-doctor', 1, 'body', 'vanished', 350)`,
      )
      .run(materialisation);
    const resolved = await doctor(store, { get: async () => null }, 400);
    const resolvedHealth = new Map(
      resolved.sources.map((source) => [`${source.source}\u0000${source.accountId}`, source]),
    );
    assert.deepEqual((resolvedHealth.get(`gmail\u0000${gmail}`) as unknown as { metadata: unknown }).metadata, {
      retryAgeMs: null,
      retryCount: 0,
      maxAttempts: 0,
      unreadable: 0,
      resolutions: { vanished: 0, unresolvable: 1, retentionExpired: 0, last: { code: 'unresolvable', at: 350 } },
    });
    assert.deepEqual(
      (resolvedHealth.get(`gmail\u0000${materialisation}`) as unknown as { materialisation: unknown }).materialisation,
      {
        retryAgeMs: null,
        retryCount: 0,
        maxAttempts: 0,
        unreadable: 0,
        resolutions: { vanished: 1, unresolvable: 0, retentionExpired: 0, last: { code: 'vanished', at: 350 } },
      },
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 doctor contains a pending-stage decrypt failure as a content-free count', { skip: WINDOWS_SKIP }, async () => {
  const { stateDir, store } = await fixture();
  try {
    store.database
      .prepare(
        `INSERT INTO source_scan_state (id, source, account_id, cursor_scope, encrypted_record, updated_at)
         VALUES ('unreadable-metadata', 'gmail', 'ibx_DOCTORUNREADABLE', 'mailbox', X'01', 100)`,
      )
      .run();
    const report = await projectB3Doctor({
      database: store.database,
      installationId: store.installationId,
      lifecycle: { enabled: true, paused: false, switchGeneration: 1 },
      protocolVersions: [1],
      ports: { assertObjectSecretReady: async () => undefined } as never,
      config: { load: async () => ({ inboxes: {}, accounts: {} }) } as never,
      approvals: { get: async () => null },
      decryptSourceState: async () => {
        throw new Error('never serialise this decrypt failure');
      },
    } as never);
    assert.deepEqual((report.sources[0] as unknown as { metadata: unknown }).metadata, {
      retryAgeMs: null,
      retryCount: 0,
      maxAttempts: 0,
      unreadable: 1,
      resolutions: { vanished: 0, unresolvable: 0, retentionExpired: 0, last: null },
    });
    assert.doesNotMatch(JSON.stringify(report), /never serialise this decrypt failure/u);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
