import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test as nodeTest } from 'node:test';
import { AuditLog } from '../../../packages/core/src/audit.ts';
import { fixture } from './helpers/secret-fixture.mjs';

const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;

async function auditShape() {
  return fixture(async ({ request, issue, root }) => {
    await request('addSubscriber', {
      document: {
        subscriberId: 'subscriber-capability',
        version: 1,
        kind: 'sse',
        authority: { host: '127.0.0.1', port: 43101 },
        origins: ['http://127.0.0.1'],
        retentionMs: 60_000,
      },
    });
    const operations = [
      ['targetSecretCreate', { targetId: 'target-capability', version: 1 }, 'RevealOnce'],
      ['targetSecretRotate', { targetId: 'target-capability', version: 1 }, 'RevealOnce'],
      [
        'targetUrlSet',
        {
          targetId: 'target-url',
          newVersion: 1,
          hidden: 'https://secret-target.example.test/synthetic-hidden-path',
          inertDraft: {
            kind: 'webhook',
            approvedAddressSet: ['8.8.8.8'],
            signing: 'standard-webhooks',
            ordering: 'strict',
            retryLimit: 20,
            representation: 'enveloped',
          },
        },
        'UrlFingerprint',
      ],
      ['subscriberTokenCreate', { subscriberId: 'subscriber-capability', version: 1 }, 'RevealOnce'],
      ['subscriberTokenRotate', { subscriberId: 'subscriber-capability', version: 1 }, 'RevealOnce'],
      [
        'judgeKeySet',
        { judgeId: 'judge-capability', version: 1, hidden: 'synthetic-hidden-judge-set' },
        'Acknowledgement',
      ],
      [
        'judgeKeyRotate',
        { judgeId: 'judge-capability', version: 1, hidden: 'synthetic-hidden-judge-rotate' },
        'Acknowledgement',
      ],
      ['migrateSecrets', { to: 'file' }, 'MigrationStatus'],
    ];
    for (const [operation, args, kind] of operations) {
      const result = await request(operation, { ...args, capability: await issue(operation) });
      assert.equal(result.kind, kind, `${operation} returns only its permitted app variant`);
      const rows = await new AuditLog(join(root, 'state')).tail();
      const row = rows.findLast((entry) => entry.operation === `events.${operation}`);
      assert.ok(row);
      const module = await import('../../../packages/events-daemon/src/runtime/desktop-secret-result.ts').catch(
        () => ({}),
      );
      assert.equal(
        typeof module.projectDesktopSecretAudit,
        'function',
        'completion validates the authoritative audit envelope',
      );
      const projected = module.projectDesktopSecretAudit(row);
      assert.deepEqual(
        Object.keys(projected).sort(),
        operation === 'migrateSecrets'
          ? ['operation', 'outcome', 'time']
          : ['id', 'operation', 'outcome', 'time', 'version'],
      );
      for (const field of ['host', 'fingerprint', 'secretReference']) {
        assert.throws(() => module.projectDesktopSecretAudit({ ...row, [field]: 'synthetic' }));
        assert.throws(() => module.projectDesktopSecretAudit({ ...row, ids: { ...row.ids, [field]: 'synthetic' } }));
      }
    }
  });
}

// desktop-mutation: desktop-secret-audit-host
test('secret-audit-shape: every authoritative operation excludes host', auditShape);

// desktop-mutation: desktop-secret-audit-fingerprint
test('secret-audit-shape: every authoritative operation excludes fingerprint', auditShape);

// desktop-mutation: desktop-secret-audit-reference
test('secret-audit-shape: every authoritative operation excludes secretReference', auditShape);
