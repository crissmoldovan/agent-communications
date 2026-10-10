import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CommsError, canonicalJson, sha256Hex } from '@agentcomms/core';
import { B3OperatorControl } from '../src/runtime/b3-operator-control.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { type EventDatabase, openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

function seedDelivery(
  store: EventDatabase,
  input: {
    readonly id: string;
    readonly state: 'retryable' | 'dead-lettered';
    readonly source?: 'gmail' | 'slack' | 'whatsapp';
    readonly whatsappMessageId?: string;
  },
): void {
  const channel = input.source ?? 'gmail';
  const options = {
    gmail: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    slack: { channel: 'slack', conversations: ['C1'] },
    whatsapp: { channel: 'whatsapp', chats: 'all-allowed' },
  } as const;
  const rule = canonicalJson({
    ruleId: 'rule-delivery',
    version: 1,
    source: {
      channel,
      accountIds: ['acc-delivery'],
      options: options[channel],
    },
    targets: [
      {
        targetId: 'target-delivery',
        version: 1,
        kind: 'webhook',
        url: { kind: 'plain', value: 'https://receiver.invalid:443/events' },
        approvedAddressSet: ['8.8.8.8'],
        signing: 'standard-webhooks',
        ordering: 'strict',
        retryLimit: 20,
        representation: 'plain',
      },
    ],
    subscribers: [],
    judges: [],
  });
  const target = JSON.parse(rule).targets[0] as Record<string, unknown>;
  store.immediate(() => {
    store.database.prepare('UPDATE event_settings SET enabled = 1, switch_generation = 7 WHERE singleton = 1').run();
    store.database
      .prepare(
        `INSERT OR IGNORE INTO rule_versions
         (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
         VALUES ('rule-delivery@1', 'rule-delivery', 1, ?, ?, 'active', 'approval-delivery', 'activation-delivery', 1)`,
      )
      .run(rule, sha256Hex(rule));
    const targetDocument = canonicalJson(target);
    store.database
      .prepare(
        'INSERT OR IGNORE INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, 1, ?, ?)',
      )
      .run('target-delivery@1', 'target-delivery', targetDocument, sha256Hex(targetDocument));
    store.database
      .prepare(
        `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
         VALUES ('event-delivery-${input.id}', ?, 'gmail.message.received', 1, 'acc-delivery', ?, 1, 1, 1)`,
      )
      .run(store.installationId, input.id);
    store.database
      .prepare(
        `INSERT INTO decisions
         (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
         VALUES (?, ?, 'acc-delivery', 'rule-delivery', 1, 'deliver', 9999999999999, 'retained')`,
      )
      .run(`decision-${input.id}`, `event-delivery-${input.id}`);
    store.database
      .prepare(
        `INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, whatsapp_message_id,
          encrypted_record, attempts, next_at, expires_at, state, switch_generation, dead_lettered_at, dead_letter_expires_at)
         VALUES (?, ?, 'acc-delivery', 'rule-delivery', 1, 'webhook:target-delivery:1', 'target-delivery', 1, ?, X'01',
          3, 123, 9999999999999, ?, 7, CASE WHEN ? = 'dead-lettered' THEN 2 ELSE NULL END,
          CASE WHEN ? = 'dead-lettered' THEN 9999999999999 ELSE NULL END)`,
      )
      .run(input.id, `decision-${input.id}`, input.whatsappMessageId ?? null, input.state, input.state, input.state);
  });
}

/**
 * Like the owner's fence, the port owns the one IMMEDIATE transaction its work runs in: a control that opened its own
 * transaction inside it would fail here as it would in production.
 */
function retryFencePorts(
  store: EventDatabase,
  fence: (input: Record<string, unknown>, work: () => unknown) => Promise<unknown>,
): {
  readonly quiescer: WriterQuiescer;
} {
  return {
    quiescer: new WriterQuiescer(),
    withDeliveryWriteFence: (input: Record<string, unknown>, work: () => unknown) =>
      fence(input, () => store.immediate(work)),
  } as never;
}

async function expectSharedRetryFence(
  name: string,
  inspect: (input: Record<string, unknown>) => void,
  source: 'gmail' | 'slack' | 'whatsapp' = 'gmail',
): Promise<void> {
  const stateDir = await shortTempDir('aev-b3-retry-shared-fence-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      seedDelivery(store, {
        id: `retry-${name}`,
        state: 'retryable',
        source,
        ...(source === 'whatsapp' ? { whatsappMessageId: 'whatsapp-message-delivery' } : {}),
      });
      let entered = 0;
      const control = new B3OperatorControl({
        store,
        ports: retryFencePorts(store, async (input) => {
          entered += 1;
          inspect(input);
          throw new Error(`shared ${name} fence refused`);
        }),
        now: () => 500,
      });
      await assert.rejects(
        () => control.handle({ operation: 'retryDelivery', args: { deliveryId: `retry-${name}` } }),
        {
          message: `shared ${name} fence refused`,
        },
      );
      assert.equal(entered, 1, `retry enters the one shared delivery fence for its ${name} gate`);
      const row = store.database.prepare('SELECT next_at FROM deliveries WHERE id = ?').get(`retry-${name}`) as {
        next_at: number;
      };
      assert.equal(row.next_at, 123, `a refused ${name} gate leaves retry scheduling unchanged`);
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('B3 retry delegates the account identity gate to the shared delivery write fence', { skip: WINDOWS_SKIP }, () =>
  expectSharedRetryFence('account', (input) => assert.equal(input.accountId, 'acc-delivery')),
);

test('B3 retry delegates the source identity gate to the shared delivery write fence', { skip: WINDOWS_SKIP }, () =>
  expectSharedRetryFence('source', (input) => assert.equal(input.source, 'slack'), 'slack'),
);

test(
  'B3 retry delegates the exact target revocation gate to the shared delivery write fence',
  { skip: WINDOWS_SKIP },
  () =>
    expectSharedRetryFence('target', (input) => {
      assert.equal(input.targetId, 'target-delivery');
      assert.equal(input.targetVersion, 1);
    }),
);

test(
  'B3 retry delegates the authorisation lineage gate to the shared delivery write fence',
  {
    skip: WINDOWS_SKIP,
  },
  () =>
    expectSharedRetryFence('lineage', (input) => {
      assert.equal(input.ruleId, 'rule-delivery');
      assert.equal(input.ruleVersion, 1);
    }),
);

test(
  'B3 retry delegates the WhatsApp live-list gate to the shared delivery write fence',
  {
    skip: WINDOWS_SKIP,
  },
  () =>
    expectSharedRetryFence(
      'whatsapp-list',
      (input) => {
        assert.equal(input.source, 'whatsapp');
        assert.equal(input.accountId, 'acc-delivery');
        assert.equal(input.whatsappMessageId, 'whatsapp-message-delivery');
      },
      'whatsapp',
    ),
);

test('B3 retry derives source identity from the canonical source-options normaliser, not a local channel list', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../src/runtime/b3-operator-control.ts', import.meta.url)),
    'utf8',
  );
  assert.match(source, /normaliseSourceOptions\(source\.options\)\.channel/);
  assert.doesNotMatch(source, /channel !== 'gmail'|channel !== 'slack'|channel !== 'resend'|channel !== 'whatsapp'/);
});

test('B3 retry changes only nextAt', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-b3-delivery-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      seedDelivery(store, { id: 'retry-delivery', state: 'retryable' });
      const control = new B3OperatorControl({
        store,
        ports: retryFencePorts(store, async (_input, work) => work()),
        now: () => 500,
      });
      const before = store.database
        .prepare('SELECT attempts, expires_at, state, switch_generation, encrypted_record FROM deliveries WHERE id = ?')
        .get('retry-delivery');
      assert.deepEqual(await control.handle({ operation: 'retryDelivery', args: { deliveryId: 'retry-delivery' } }), {
        kind: 'delivery-retried',
        deliveryId: 'retry-delivery',
        nextAt: 500,
      });
      const after = store.database
        .prepare(
          'SELECT attempts, next_at, expires_at, state, switch_generation, encrypted_record FROM deliveries WHERE id = ?',
        )
        .get('retry-delivery') as Record<string, unknown>;
      assert.equal(after.next_at, 500);
      const beforeRecord = before as Record<string, unknown>;
      assert.equal(after.attempts, beforeRecord.attempts);
      assert.equal(after.expires_at, beforeRecord.expires_at);
      assert.equal(after.state, beforeRecord.state);
      assert.equal(after.switch_generation, beforeRecord.switch_generation);
      assert.deepEqual(after.encrypted_record, beforeRecord.encrypted_record, 'manual retry preserves retained bytes');
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 retry refuses a dead-lettered delivery', { skip: WINDOWS_SKIP }, async () => {
  const stateDir = await shortTempDir('aev-b3-delivery-dead-letter-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      seedDelivery(store, { id: 'dead-delivery', state: 'dead-lettered' });
      const control = new B3OperatorControl({
        store,
        ports: retryFencePorts(store, async (_input, work) => work()),
        now: () => 500,
      });
      await assert.rejects(
        () => control.handle({ operation: 'retryDelivery', args: { deliveryId: 'dead-delivery' } }),
        (error: unknown) => (error as { code?: unknown }).code === 'APPROVAL_VOID',
        'a dead letter is terminal and cannot be redriven',
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 drop clears its dead-letter retained payload', { skip: WINDOWS_SKIP }, async () => {
  const stateDir = await shortTempDir('aev-b3-delivery-drop-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      seedDelivery(store, { id: 'dead-delivery', state: 'dead-lettered' });
      store.immediate(() => {
        store.database
          .prepare(
            `INSERT INTO dryrun_log
             (delivery_id, rule_id, rule_version, target_id, target_version, event_id, account_id, encrypted_record, delivered_at, expires_at)
             VALUES ('dead-delivery', 'rule-delivery', 1, 'target-delivery', 1, 'event-delivery-dead-delivery', 'acc-delivery', X'02', 1, 2)`,
          )
          .run();
      });
      const control = new B3OperatorControl({
        store,
        ports: retryFencePorts(store, async (_input, work) => work()),
        now: () => 500,
      });
      assert.deepEqual(await control.handle({ operation: 'dropDelivery', args: { deliveryId: 'dead-delivery' } }), {
        kind: 'delivery-dropped',
        deliveryId: 'dead-delivery',
      });
      const dropped = store.database
        .prepare('SELECT encrypted_record, next_at, lease_until FROM deliveries WHERE id = ?')
        .get('dead-delivery') as Record<string, unknown>;
      assert.equal(dropped.encrypted_record, null);
      assert.equal(dropped.next_at, null);
      assert.equal(dropped.lease_until, null, 'drop clears the retained payload in its terminal delivery row');
      const dryrun = store.database
        .prepare('SELECT count(*) AS count FROM dryrun_log WHERE delivery_id = ?')
        .get('dead-delivery') as { count: number };
      assert.equal(dryrun.count, 0);
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 retry refuses immutable state, deadline and generation changes', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-b3-delivery-object-fence-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      seedDelivery(store, { id: 'object-fence-delivery', state: 'retryable' });
      const control = new B3OperatorControl({
        store,
        ports: retryFencePorts(store, async (input, work) => {
          if (input.switchGeneration !== 7) throw new CommsError('APPROVAL_VOID', 'stale switch');
          return work();
        }),
        now: () => 500,
      });
      store.immediate(() => {
        store.database.prepare('UPDATE deliveries SET attempts = 20 WHERE id = ?').run('object-fence-delivery');
      });
      await assert.rejects(
        () => control.handle({ operation: 'retryDelivery', args: { deliveryId: 'object-fence-delivery' } }),
        (error: unknown) => (error as { code?: unknown }).code === 'APPROVAL_VOID',
        'the original exact target retry limit is terminal',
      );
      store.immediate(() => {
        store.database
          .prepare('UPDATE deliveries SET attempts = 3, expires_at = 500 WHERE id = ?')
          .run('object-fence-delivery');
      });
      await assert.rejects(
        () => control.handle({ operation: 'retryDelivery', args: { deliveryId: 'object-fence-delivery' } }),
        (error: unknown) => (error as { code?: unknown }).code === 'APPROVAL_VOID',
        'the original delivery deadline is terminal',
      );
      store.immediate(() => {
        store.database
          .prepare('UPDATE deliveries SET expires_at = 9999999999999, switch_generation = 6 WHERE id = ?')
          .run('object-fence-delivery');
      });
      await assert.rejects(
        () => control.handle({ operation: 'retryDelivery', args: { deliveryId: 'object-fence-delivery' } }),
        (error: unknown) => (error as { code?: unknown }).code === 'APPROVAL_VOID',
        'a delivery from another switch generation cannot be retried',
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
