import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { ACTIVATION_FAILURE_CODES } from '../src/domain/activation-failure-codes.ts';
import { assertDoctorReportV1 } from '../src/operations/doctor.ts';
import { projectB3Doctor } from '../src/runtime/b3-doctor-projection.ts';
import { ResendReceivedSource } from '../src/sources/resend.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

function stableRuleDocument(input: { readonly ruleId: string; readonly version: number; readonly state: string }) {
  return canonicalJson({
    ruleId: input.ruleId,
    version: input.version,
    source: {
      channel: 'gmail',
      accountIds: ['ibx_DOCTORACCOUNT01'],
      options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
    mapping: { constant: 'doctor-safe' },
    targets: [{ targetId: 'target-doctor-missing', version: 1, kind: 'webhook' }],
    subscribers: [],
    judges: [],
    state: input.state,
  });
}

function insertRule(
  database: Awaited<ReturnType<typeof openEventDatabase>>['database'],
  input: { readonly ruleId: string; readonly version: number; readonly state: 'active' | 'superseded' },
): void {
  const document = stableRuleDocument(input);
  database
    .prepare(
      `INSERT INTO rule_versions
       (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at, superseded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${input.ruleId}@${input.version}`,
      input.ruleId,
      input.version,
      document,
      sha256Hex(document),
      input.state,
      `approval-${input.ruleId}`,
      `activation-${input.ruleId}`,
      100,
      input.state === 'superseded' ? 200 : null,
    );
}

test('B3 doctor reports closed lineage, completion, recovery, and unavailable health state', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-b3-doctor-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const database = store.database;
      insertRule(database, { ruleId: 'rule-doctor-active', version: 1, state: 'active' });
      insertRule(database, { ruleId: 'rule-doctor-retained', version: 2, state: 'superseded' });
      database
        .prepare(
          `INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
           VALUES ('rule', 'rule-doctor-active', 1, 'activation-doctor-active', 100)`,
        )
        .run();
      database
        .prepare(
          `INSERT INTO rule_activation_points
           (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
           VALUES ('activation-doctor-active', 'rule-doctor-active', 1, 'gmail', 'ibx_DOCTORACCOUNT01', 'mailbox', X'01', 101)`,
        )
        .run();
      const target = canonicalJson({
        targetId: 'target-doctor-missing',
        version: 1,
        kind: 'webhook',
        url: { kind: 'plain', value: 'https://doctor.invalid/never-rendered' },
      });
      database
        .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
        .run('target-doctor-missing@1', 'target-doctor-missing', target, sha256Hex(target));
      database
        .prepare(
          'INSERT INTO subscriber_versions (id, subscriber_id, version, document, digest) VALUES (?, ?, 1, ?, ?)',
        )
        .run('subscriber-doctor-missing@1', 'subscriber-doctor-missing', '{}', 'subscriber-doctor-digest');
      for (const [id, kind, status, failureCode] of [
        ['intent-doctor-pending', 'rule', 'pending', null],
        ['intent-doctor-claimed', 'rule', 'pending-completion', null],
        ['intent-doctor-failed', 'enable-all', 'failed', 'COMPLETION_TIMEOUT'],
      ] as const) {
        database
          .prepare(
            `INSERT INTO activation_intents
             (id, kind, document, digest, effect, required_points, acquisition_scopes, status, claimed_at,
              completion_deadline, failure_code, created_at, updated_at)
             VALUES (?, ?, '{}', 'doctor-digest', '{}', '[]', '[]', ?, ?, ?, ?, 10, 20)`,
          )
          .run(
            id,
            kind,
            status,
            status === 'pending-completion' ? 30 : null,
            status === 'pending-completion' ? 40 : null,
            failureCode,
          );
      }
      database
        .prepare(
          `INSERT INTO activation_baselines
           (intent_id, source, account_id, position_scope, encrypted_position, response_at)
           VALUES ('intent-doctor-claimed', 'gmail', 'ibx_DOCTORACCOUNT01', 'mailbox', X'02', 31)`,
        )
        .run();
      database
        .prepare(
          `INSERT INTO replacement_drains
           (intent_id, source, account_id, position_scope, old_in_scope, new_in_scope, drained_at)
           VALUES ('intent-doctor-claimed', 'gmail', 'ibx_DOCTORACCOUNT01', 'mailbox', 1, 1, NULL)`,
        )
        .run();
      database
        .prepare(
          `INSERT INTO source_occurrence_resolutions
           (source, account_id, occurrence_key, outcome, resolved_at, error_code)
           VALUES ('gmail', 'ibx_DOCTORACCOUNT01', 'opaque-occurrence', 'unresolvable', 50, 'SOURCE_UNRESOLVABLE')`,
        )
        .run();
      database
        .prepare(
          `INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at)
           VALUES ('gmail', 'ibx_DOCTORACCOUNT01', 'mailbox', 'opaque-cursor', 60)`,
        )
        .run();
      database
        .prepare(
          `INSERT INTO worker_leases (work_id, kind, switch_generation, lease_until, updated_at)
           VALUES ('lease-doctor', 'dispatch', 0, 70, 60)`,
        )
        .run();
      database
        .prepare(
          `INSERT INTO reset_barriers (reset_epoch, target_id, target_version, state, reset_delivery_id, degraded_at)
           VALUES (1, 'target-doctor-missing', 1, 'degraded', 'reset-doctor', 80)`,
        )
        .run();
      database
        .prepare(
          `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
           VALUES ('event-doctor-health', ?, 'gmail.message.received', 1, 'ibx_DOCTORACCOUNT01', 'doctor-health', 1, 1, 1)`,
        )
        .run(store.installationId);
      database
        .prepare(
          `INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection)
           VALUES ('event-doctor-health', 'rule-doctor-retained', 2, 100, X'01')`,
        )
        .run();
      database
        .prepare(
          `INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
           VALUES ('decision-doctor-health', 'event-doctor-health', 'ibx_DOCTORACCOUNT01', 'rule-doctor-retained', 2, 'hold', 999, 'retained')`,
        )
        .run();
      database
        .prepare(
          `INSERT INTO deliveries
             (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
              expires_at, state, switch_generation)
           VALUES ('delivery-doctor-dead', 'decision-doctor-health', 'ibx_DOCTORACCOUNT01', 'rule-doctor-retained', 2,
                   'dryrun:target-doctor-missing:1', 'target-doctor-missing', 1, 999, 'dead-lettered', 0)`,
        )
        .run();
      database
        .prepare(
          `INSERT INTO whatsapp_visibility (account_id, version, lists_digest, changed_at)
           VALUES ('acc_DOCTORWHATSAPP', 1, ?, 90)`,
        )
        .run('a'.repeat(64));
      database
        .prepare(
          `INSERT INTO whatsapp_visibility (account_id, version, lists_digest, changed_at)
           VALUES ('acc_DOCTORWHATSAPPSTALE', 1, ?, 91)`,
        )
        .run('b'.repeat(64));
      database.prepare('UPDATE event_settings SET enabled = 1, paused = 1, switch_generation = 7').run();

      const report = await projectB3Doctor({
        database,
        installationId: store.installationId,
        lifecycle: { enabled: true, paused: true, switchGeneration: 7 },
        protocolVersions: [1],
        now: () => 100,
        ports: {
          assertObjectSecretReady: async () => {
            throw Object.assign(new Error('incomplete'), { code: 'OBJECT_SECRET_INCOMPLETE' });
          },
        } as never,
        config: {
          load: async () => ({
            inboxes: { doctor: { id: 'ibx_DOCTORACCOUNT01', provider: 'gmail' } },
            accounts: {
              whatsapp: { id: 'acc_DOCTORWHATSAPP', platform: 'whatsapp' },
              missingWhatsapp: { id: 'acc_DOCTORWHATSAPPMISSING', platform: 'whatsapp' },
            },
          }),
        } as never,
        approvals: { get: async () => null } as never,
        decryptSourceState: async () => null,
      });

      assert.deepEqual(report.schemaVersion, 'doctor-v1');
      assert.deepEqual(report.switch, { status: 'enabled', paused: true, generation: 7 });
      assert.deepEqual(report.owner, {
        status: 'running',
        protocolVersions: [1],
        installationId: store.installationId,
      });
      assert.deepEqual(report.lineages, [
        {
          ruleId: 'rule-doctor-active',
          ruleVersion: 1,
          status: 'active',
          approvalId: 'approval-rule-doctor-active',
          authorizationActivationId: 'activation-rule-doctor-active',
          currentCutoverId: 'activation-doctor-active',
          activatedAt: 100,
          retainedWork: 0,
          validation: { status: 'invalid', code: 'IMMUTABLE_VERSION_DRIFT' },
          derivation: [],
        },
      ]);
      assert.deepEqual(report.superseded, [{ ruleId: 'rule-doctor-retained', ruleVersion: 2, retainedWork: 1 }]);
      assert.deepEqual(report.points, [
        {
          activationId: 'activation-doctor-active',
          ruleId: 'rule-doctor-active',
          ruleVersion: 1,
          source: 'gmail',
          accountId: 'ibx_DOCTORACCOUNT01',
          scopeId: 'mailbox',
          status: 'active',
          createdAt: 101,
        },
      ]);
      assert.ok(
        report.activationIntents.some((intent) => intent.id === 'intent-doctor-pending' && intent.status === 'pending'),
      );
      assert.ok(
        report.activationIntents.some(
          (intent) =>
            intent.id === 'intent-doctor-claimed' && intent.status === 'pending-completion' && intent.draining === 1,
        ),
      );
      assert.ok(
        report.activationIntents.some(
          (intent) => intent.id === 'intent-doctor-failed' && intent.failureCode === 'COMPLETION_TIMEOUT',
        ),
      );
      assert.deepEqual(report.sources, [
        {
          source: 'gmail',
          accountId: 'ibx_DOCTORACCOUNT01',
          metadata: {
            retryAgeMs: null,
            retryCount: 0,
            maxAttempts: 0,
            unreadable: 0,
            resolutions: {
              vanished: 0,
              unresolvable: 1,
              retentionExpired: 0,
              last: { code: 'unresolvable', at: 50 },
            },
          },
          materialisation: {
            retryAgeMs: null,
            retryCount: 0,
            maxAttempts: 0,
            unreadable: 0,
            resolutions: {
              vanished: 0,
              unresolvable: 0,
              retentionExpired: 0,
              last: null,
            },
          },
          lagMs: 40,
        },
      ]);
      assert.deepEqual(report.recovery, {
        leases: 1,
        held: 1,
        deadLetters: 1,
        deadlines: 1,
        resetBarriers: [{ state: 'degraded', count: 1 }],
        missingSecrets: [
          { kind: 'subscriber', id: 'subscriber-doctor-missing', version: 1 },
          { kind: 'target', id: 'target-doctor-missing', version: 1 },
        ],
      });
      assert.deepEqual(report.judgeBoundary, [
        { kind: 'typesafe', code: 'E_REQUIRED', phase: 'E' },
        { kind: 'local-endpoint', code: 'E_REQUIRED', phase: 'E' },
        { kind: 'laya', code: 'E2_REQUIRED', phase: 'E2' },
      ]);
      assert.deepEqual(report.whatsapp, [
        { accountId: 'acc_DOCTORWHATSAPP', status: 'applied', appliedAt: 90 },
        { accountId: 'acc_DOCTORWHATSAPPMISSING', status: 'missing', appliedAt: null },
        { accountId: 'acc_DOCTORWHATSAPPSTALE', status: 'stale', appliedAt: 91 },
      ]);

      const schema = JSON.parse(
        await readFile(new URL('../src/operations/contracts/doctor-v1.schema.json', import.meta.url), 'utf8'),
      ) as { readonly additionalProperties?: unknown; readonly properties?: Record<string, unknown> };
      assert.equal(schema.additionalProperties, false, 'DoctorReportV1 is a closed top-level schema');
      assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), Object.keys(report).sort());
      assert.throws(
        () => assertDoctorReportV1({ ...report, unrecognised: 'forbidden' } as never),
        /doctor-v1 report is closed/,
        'the checked production binding rejects a field not named by the closed schema',
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 doctor marks a malformed purported derivation as invalid instead of serialising it as effective', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-b3-doctor-lineage-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const database = store.database;
      const ruleId = 'rule-doctor-derived';
      for (const [version, state, authorizationActivationId] of [
        [1, 'superseded', 'activation-doctor-root'],
        [2, 'superseded', `${ruleId}@2`],
        [3, 'active', `${ruleId}@3`],
      ] as const) {
        const document = stableRuleDocument({ ruleId, version, state });
        database
          .prepare(
            `INSERT INTO rule_versions
             (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at, superseded_at)
             VALUES (?, ?, ?, ?, ?, ?, 'approval-doctor-root', ?, 10, ?)`,
          )
          .run(
            `${ruleId}@${version}`,
            ruleId,
            version,
            document,
            sha256Hex(document),
            state,
            authorizationActivationId,
            state === 'superseded' ? 20 : null,
          );
      }
      database
        .prepare(
          `INSERT INTO derived_authorizations (version_id, parent_approval_id, parent_version_id, edit_kind, created_at)
           VALUES (?, 'approval-doctor-root', ?, ?, 11)`,
        )
        .run(`${ruleId}@2`, `${ruleId}@1`, 'narrow-source-options');
      database
        .prepare(
          `INSERT INTO derived_authorizations (version_id, parent_approval_id, parent_version_id, edit_kind, created_at)
           VALUES (?, 'approval-doctor-root', ?, ?, 12)`,
        )
        .run(`${ruleId}@3`, `${ruleId}@2`, 'lower-rate-cap');
      database
        .prepare(
          `INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
           VALUES ('rule', ?, 3, 'activation-doctor-derived', 10)`,
        )
        .run(ruleId);

      const report = await projectB3Doctor({
        database,
        installationId: store.installationId,
        lifecycle: { enabled: true, paused: false, switchGeneration: 1 },
        protocolVersions: [1],
        ports: { assertObjectSecretReady: async () => undefined } as never,
        config: { load: async () => ({ inboxes: {}, accounts: {} }) } as never,
        approvals: { get: async () => null } as never,
        decryptSourceState: async () => null,
      });

      assert.deepEqual(report.lineages, [
        {
          ruleId,
          ruleVersion: 3,
          status: 'active',
          approvalId: 'approval-doctor-root',
          authorizationActivationId: `${ruleId}@3`,
          currentCutoverId: 'activation-doctor-derived',
          activatedAt: 10,
          retainedWork: 0,
          validation: { status: 'invalid', code: 'IMMUTABLE_VERSION_DRIFT' },
          derivation: [],
        },
      ]);
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 doctor reports Gmail metadata and lazy materialisation recovery independently', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-b3-doctor-materialisation-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const database = store.database;
      const accountId = 'ibx_DOCTORMATERIALISATION';
      database
        .prepare(
          `INSERT INTO source_occurrence_resolutions (source, account_id, occurrence_key, outcome, resolved_at)
           VALUES ('gmail', ?, 'metadata-occurrence', 'unresolvable', 80)`,
        )
        .run(accountId);
      database
        .prepare(
          `INSERT INTO source_scan_state (id, source, account_id, cursor_scope, encrypted_record, updated_at)
           VALUES ('materialisation-retry', 'gmail', ?, 'materialisation', X'01', 100)`,
        )
        .run(accountId);
      database
        .prepare(
          `INSERT INTO source_projection_resolutions
           (source, account_id, occurrence_key, rule_id, rule_version, materialization_key, outcome, resolved_at)
           VALUES ('gmail', ?, 'lazy-occurrence', 'rule-materialisation', 1, 'body', 'vanished', 150)`,
        )
        .run(accountId);

      const report = await projectB3Doctor({
        database,
        installationId: store.installationId,
        lifecycle: { enabled: true, paused: false, switchGeneration: 1 },
        protocolVersions: [1],
        now: () => 200,
        ports: { assertObjectSecretReady: async () => undefined } as never,
        config: { load: async () => ({ inboxes: {}, accounts: {} }) } as never,
        approvals: { get: async () => null } as never,
        decryptSourceState: async () => null,
      });

      assert.deepEqual(report.sources, [
        {
          source: 'gmail',
          accountId,
          metadata: {
            retryAgeMs: null,
            retryCount: 0,
            maxAttempts: 0,
            unreadable: 0,
            resolutions: {
              vanished: 0,
              unresolvable: 1,
              retentionExpired: 0,
              last: { code: 'unresolvable', at: 80 },
            },
          },
          materialisation: {
            retryAgeMs: null,
            retryCount: 0,
            maxAttempts: 0,
            unreadable: 0,
            resolutions: {
              vanished: 1,
              unresolvable: 0,
              retentionExpired: 0,
              last: { code: 'vanished', at: 150 },
            },
          },
          lagMs: null,
        },
      ]);
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 doctor routes a Resend received-email 404 to materialisation and keeps Gmail metadata separate', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-b3-doctor-resolution-source-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const resendAccountId = 'acc_DOCTORRESEND404';
      const gmailAccountId = 'ibx_DOCTORGMAIL404';
      const anchor = 'resend-anchor';
      const missing = 'resend-detail-404';
      const source = new ResendReceivedSource({
        store,
        accountId: resendAccountId,
        reader: {
          async listReceived() {
            return source.anchorId() === null
              ? { emails: [{ id: anchor }], next: null }
              : { emails: [{ id: missing }, { id: anchor }], next: null };
          },
          async getReceived() {
            // The Resend adapter has normalized the received-email detail endpoint's 404.
            return { kind: 'vanished' as const };
          },
          async listSent() {
            return { emails: [], next: null };
          },
        },
        encrypt: async (value) => Buffer.from(JSON.stringify(value)),
        decrypt: async (stored) => JSON.parse(Buffer.from(stored).toString('utf8')) as unknown,
        debts: () => [{ ruleId: 'rule-doctor-resolution', ruleVersion: 1, ingestRetentionMs: 1_000 }],
        admit: async () => 'terminal',
        now: () => 200,
      });
      await source.baseline();
      await source.scan();
      store.database
        .prepare(
          `INSERT INTO source_occurrence_resolutions
           (source, account_id, occurrence_key, outcome, resolved_at, error_code)
           VALUES ('gmail', ?, 'gmail-metadata-404', 'vanished', 80, 'NOT_FOUND')`,
        )
        .run(gmailAccountId);

      const report = await projectB3Doctor({
        database: store.database,
        installationId: store.installationId,
        lifecycle: { enabled: true, paused: false, switchGeneration: 1 },
        protocolVersions: [1],
        now: () => 300,
        ports: { assertObjectSecretReady: async () => undefined } as never,
        config: { load: async () => ({ inboxes: {}, accounts: {} }) } as never,
        approvals: { get: async () => null } as never,
        decryptSourceState: async (stored) => JSON.parse(Buffer.from(stored).toString('utf8')) as unknown,
      });

      const gmail = report.sources.find((entry) => entry.source === 'gmail' && entry.accountId === gmailAccountId);
      const resend = report.sources.find((entry) => entry.source === 'resend' && entry.accountId === resendAccountId);
      assert.deepEqual(gmail?.metadata.resolutions, {
        vanished: 1,
        unresolvable: 0,
        retentionExpired: 0,
        last: { code: 'vanished', at: 80 },
      });
      assert.deepEqual(gmail?.materialisation.resolutions, {
        vanished: 0,
        unresolvable: 0,
        retentionExpired: 0,
        last: null,
      });
      assert.deepEqual(resend?.metadata.resolutions, {
        vanished: 0,
        unresolvable: 0,
        retentionExpired: 0,
        last: null,
      });
      assert.deepEqual(resend?.materialisation.resolutions, {
        vanished: 1,
        unresolvable: 0,
        retentionExpired: 0,
        last: { code: 'vanished', at: 200 },
      });
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 doctor exposes only recognised activation failure codes', { skip: WINDOWS_SKIP }, async () => {
  const stateDir = await shortTempDir('aev-b3-doctor-failure-code-');
  const writerCodes = [
    'ACCOUNT_REMOVED',
    'APPROVAL_ABSENT',
    'APPROVAL_BINDING_DRIFT',
    'AUTHORIZATION_REVOKED',
    'COMPLETION_TIMEOUT',
    'STALE_GENERATION',
    'STALE_POINTER',
  ] as const;
  assert.deepEqual(
    ACTIVATION_FAILURE_CODES,
    writerCodes,
    "the closed doctor vocabulary is the activation writers' source",
  );
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      for (const [index, failureCode] of writerCodes.entries()) {
        store.database
          .prepare(
            `INSERT INTO activation_intents
             (id, kind, document, digest, effect, required_points, acquisition_scopes, status, failure_code, created_at, updated_at)
             VALUES (?, 'rule', '{}', 'digest', '{}', '[]', '[]', 'failed', ?, ?, ?)`,
          )
          .run(`intent-doctor-writer-${index}`, failureCode, index, index);
      }
      store.database
        .prepare(
          `INSERT INTO activation_intents
           (id, kind, document, digest, effect, required_points, acquisition_scopes, status, failure_code, created_at, updated_at)
           VALUES ('intent-doctor-unrecognised', 'rule', '{}', 'digest', '{}', '[]', '[]', 'failed', 'DOCTOR_SECRET_MARKER', 100, 100)`,
        )
        .run();

      const report = await projectB3Doctor({
        database: store.database,
        installationId: store.installationId,
        lifecycle: { enabled: true, paused: false, switchGeneration: 1 },
        protocolVersions: [1],
        ports: { assertObjectSecretReady: async () => undefined } as never,
        config: { load: async () => ({ inboxes: {}, accounts: {} }) } as never,
        approvals: { get: async () => null } as never,
        decryptSourceState: async () => null,
      });
      assert.deepEqual(
        report.activationIntents.map((intent) => intent.failureCode),
        [...writerCodes, 'UNRECOGNISED'],
      );
      assert.doesNotMatch(JSON.stringify(report), /DOCTOR_SECRET_MARKER/u);

      const schema = JSON.parse(
        await readFile(new URL('../src/operations/contracts/doctor-v1.schema.json', import.meta.url), 'utf8'),
      ) as {
        readonly $defs?: {
          readonly intent?: {
            readonly properties?: { readonly failureCode?: { readonly anyOf?: readonly unknown[] } };
          };
        };
      };
      const failureCodeSchema = schema.$defs?.intent?.properties?.failureCode?.anyOf?.[0] as
        | { readonly enum?: unknown }
        | undefined;
      assert.deepEqual(failureCodeSchema?.enum, [...writerCodes, 'UNRECOGNISED']);
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 doctor lists only superseded versions that own non-terminal or retained delivery, dry-run, stream, or hold work', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-b3-doctor-retained-work-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const database = store.database;
      const ruleId = 'rule-doctor-retained-kind';
      for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
        insertRule(database, { ruleId, version, state: 'superseded' });
      }
      const insertDecision = (version: number, outcome: 'allow' | 'hold' = 'allow') => {
        const eventId = `event-retained-${version}`;
        const decisionId = `decision-retained-${version}`;
        database
          .prepare(
            `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
             VALUES (?, ?, 'gmail.message.received', 1, 'ibx_DOCTORACCOUNT01', ?, 1, 1, 1)`,
          )
          .run(eventId, store.installationId, eventId);
        database
          .prepare(
            `INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
             VALUES (?, ?, 'ibx_DOCTORACCOUNT01', ?, ?, ?, 1000, 'retained')`,
          )
          .run(decisionId, eventId, ruleId, version, outcome);
        return { eventId, decisionId };
      };
      const insertDelivery = (version: number, state: string, encrypted = false) => {
        const { eventId, decisionId } = insertDecision(version);
        const deliveryId = `delivery-retained-${version}`;
        database
          .prepare(
            `INSERT INTO deliveries
             (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, encrypted_record,
              expires_at, state, switch_generation)
             VALUES (?, ?, 'ibx_DOCTORACCOUNT01', ?, ?, ?, 'target-retained', 1, ?, 1000, ?, 0)`,
          )
          .run(
            deliveryId,
            decisionId,
            ruleId,
            version,
            `target-retained:${version}`,
            encrypted ? Buffer.from([1]) : null,
            state,
          );
        return { eventId, deliveryId };
      };

      insertDelivery(1, 'queued', true);
      insertDelivery(2, 'retryable', true);
      insertDelivery(3, 'disclosing', true);
      insertDelivery(4, 'in-flight-at-disable');
      insertDelivery(5, 'in-flight-at-account-removal');
      insertDelivery(6, 'dead-lettered', true);
      insertDelivery(7, 'delivered', true);
      const dryrun = insertDelivery(8, 'delivered');
      database
        .prepare(
          `INSERT INTO dryrun_log
           (delivery_id, rule_id, rule_version, target_id, target_version, event_id, account_id, encrypted_record, delivered_at, expires_at)
           VALUES (?, ?, 8, 'target-retained', 1, ?, 'ibx_DOCTORACCOUNT01', X'01', 1, 2)`,
        )
        .run(dryrun.deliveryId, ruleId, dryrun.eventId);
      const stream = insertDelivery(9, 'delivered');
      database
        .prepare(
          `INSERT INTO stream_log
           (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version,
            event_id, account_id, encrypted_record, delivered_at, expires_at, switch_generation)
           VALUES ('stream-retained-9', ?, ?, 9, 'target-retained', 1, 'subscriber-retained', 1, ?,
                   'ibx_DOCTORACCOUNT01', X'01', 1, 2, 0)`,
        )
        .run(stream.deliveryId, ruleId, stream.eventId);
      insertDecision(10, 'hold');

      const report = await projectB3Doctor({
        database,
        installationId: store.installationId,
        lifecycle: { enabled: true, paused: false, switchGeneration: 1 },
        protocolVersions: [1],
        ports: { assertObjectSecretReady: async () => undefined } as never,
        config: { load: async () => ({ inboxes: {}, accounts: {} }) } as never,
        approvals: { get: async () => null } as never,
        decryptSourceState: async () => null,
      });

      assert.deepEqual(report.superseded, [
        { ruleId, ruleVersion: 1, retainedWork: 1 },
        { ruleId, ruleVersion: 2, retainedWork: 1 },
        { ruleId, ruleVersion: 3, retainedWork: 1 },
        { ruleId, ruleVersion: 4, retainedWork: 1 },
        { ruleId, ruleVersion: 5, retainedWork: 1 },
        { ruleId, ruleVersion: 6, retainedWork: 1 },
        { ruleId, ruleVersion: 7, retainedWork: 1 },
        { ruleId, ruleVersion: 8, retainedWork: 1 },
        { ruleId, ruleVersion: 9, retainedWork: 1 },
        { ruleId, ruleVersion: 10, retainedWork: 1 },
      ]);
      assert.equal(
        report.superseded.some((version) => version.ruleVersion === 11),
        false,
        'a fully purged superseded version is not reported',
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
