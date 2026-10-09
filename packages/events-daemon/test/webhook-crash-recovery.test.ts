import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { WEBHOOK_CRASH_POINTS, type WebhookCrashPoint } from './fixtures/webhook-crash-points.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();
const { claimDelivery } = await import('../src/runtime/delivery-claim.ts');
const { EventLifecycle } = await import('../src/runtime/lifecycle.ts');
const { openEventDatabase } = await import('../src/store/database.ts');
const { WebhookDispatcher, settleWebhookOutcome } = await import('../src/runtime/webhook-dispatcher.ts');

const ACCOUNT = 'ibx_WEBHOOK_CRASH';
const NOW = 1_700_000_000_000;
const SIGNING_KEY = 'whsec_Y3Jhc2gtcmVjb3ZlcnktZml4dHVyZQ==';

async function fixture() {
  const stateDir = await shortTempDir('events-webhook-crash-');
  const store = await openEventDatabase({ stateDir });
  const target = {
    targetId: 'target-crash',
    version: 1,
    kind: 'webhook' as const,
    url: { kind: 'plain' as const, value: 'https://receiver.test:44444/crash' },
    approvedAddressSet: ['127.0.0.1'],
    signing: 'standard-webhooks' as const,
    ordering: 'strict' as const,
    retryLimit: 3,
    representation: 'plain' as const,
  };
  const targetJson = canonicalJson(target);
  store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 7');
  store.database.exec(`INSERT INTO rule_versions
    (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
    VALUES ('rule-crash@1', 'rule-crash', 1,
      '{"deliveryRateCap":20,"retention":{"deadLetterMs":1000}}', 'rule-digest', 'active', 'approval', 'activation', 1)`);
  store.database
    .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
    .run('target-crash@1', 'target-crash', 1, targetJson, sha256Hex(targetJson));
  store.database
    .prepare(
      `INSERT INTO event_secret_generations
       (owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest, encrypted_ref, lifecycle, expires_at, created_at)
       VALUES ('target', 'target-crash', 1, 'webhook-signing', 1, ?, ?, X'01', 'current', NULL, 1)`,
    )
    .run(sha256Hex(targetJson), sha256Hex(SIGNING_KEY));
  store.database.exec(`INSERT INTO ingest
    (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
    VALUES ('event-crash', '${store.installationId}', 'gmail.message.received', 1, '${ACCOUNT}', 'dedupe', 1, 1, 1);
    INSERT INTO decisions
    (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
    VALUES ('decision-crash', 'event-crash', '${ACCOUNT}', 'rule-crash', 1, 'matched', 2000000000000, 'retained');`);
  store.database
    .prepare(
      `INSERT INTO deliveries
       (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
        target_representation, encrypted_record, expires_at, state, switch_generation, next_at)
       VALUES ('delivery-crash', 'decision-crash', ?, 'rule-crash', 1, 'webhook:target-crash:1', 'target-crash', 1,
        'webhook', 'plain', ?, 2000000000000, 'queued', 7, 0)`,
    )
    .run(
      ACCOUNT,
      Buffer.from(
        JSON.stringify({ cloudEventBytes: '{"id":"delivery-crash"}', untrusted: [], representation: 'plain' }),
      ),
    );
  return { stateDir, store };
}

function dispatcher(
  setup: Awaited<ReturnType<typeof fixture>>,
  options: Readonly<{
    failpoint?: (point: WebhookCrashPoint) => void;
    response?: number;
    fence?: () => Promise<void>;
    now?: number;
    onResponse?: () => void;
    accountLive?: () => boolean;
  }> = {},
) {
  let data: ((chunk: Buffer) => void) | undefined;
  let ended: (() => void) | undefined;
  let failed: ((error: Error) => void) | undefined;
  const socket = {
    write() {
      queueMicrotask(() => {
        if (options.response === undefined) failed?.(new Error('fixture reset'));
        else {
          options.onResponse?.();
          data?.(Buffer.from(`HTTP/1.1 ${options.response} Fixture\r\nContent-Length: 0\r\n\r\n`));
          ended?.();
        }
      });
      return true;
    },
    destroy() {},
    once(event: string, listener: (error: Error) => void) {
      if (event === 'error') failed = listener;
      if (event === 'end') ended = listener as () => void;
      return this;
    },
    on(event: string, listener: (chunk: Buffer) => void) {
      if (event === 'data') data = listener;
      return this;
    },
  };
  return new WebhookDispatcher({
    store: setup.store,
    cipher: {
      async decrypt(_: unknown, value: Uint8Array) {
        return Buffer.from(value);
      },
    },
    approvals: { get: async () => null },
    config: {
      load: async () =>
        options.accountLive?.() === false
          ? { inboxes: {} }
          : { inboxes: { mailbox: { id: ACCOUNT, provider: 'gmail' } } },
    } as never,
    fence: options.fence ?? (async () => undefined),
    secretReader: async () => [
      { generation: 1, lifecycle: 'current' as const, secretDigest: sha256Hex(SIGNING_KEY), material: SIGNING_KEY },
    ],
    resolver: { lookup: async () => ['127.0.0.1'] },
    tcpConnect: async () => socket as never,
    tlsConnect: async () => socket as never,
    now: () => options.now ?? NOW,
    testFailpoint: options.failpoint,
  });
}

test('B2-T7: every pre-outcome crash preserves one owned recovery lease and one cap charge', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  for (const point of WEBHOOK_CRASH_POINTS.filter((entry) => entry !== 'after-outcome')) {
    await t.test(point, async () => {
      const setup = await fixture();
      try {
        const stop = () => {
          throw new Error(`crash:${point}`);
        };
        await assert.rejects(
          dispatcher(setup, { response: 204, failpoint: (current) => current === point && stop() }).dispatch(
            'delivery-crash',
          ),
          new RegExp(`crash:${point}`),
        );
        const row = setup.store.database
          .prepare("SELECT state, attempts, encrypted_record FROM deliveries WHERE id = 'delivery-crash'")
          .get() as { state: string; attempts: number; encrypted_record: Uint8Array | null };
        const charges = setup.store.database.prepare('SELECT count(*) AS count FROM delivery_cap_charges').get() as {
          count: number;
        };
        if (point === 'before-claim') {
          assert.deepEqual(
            { state: row.state, attempts: row.attempts, charges: charges.count },
            { state: 'queued', attempts: 0, charges: 0 },
          );
        } else {
          assert.deepEqual(
            { state: row.state, attempts: row.attempts, charges: charges.count },
            { state: 'disclosing', attempts: 1, charges: 1 },
          );
          assert.ok(row.encrypted_record, 'a crashed owner leaves only its existing exact lease recoverable');
        }
      } finally {
        setup.store.close();
        await rm(setup.stateDir, { recursive: true, force: true });
      }
    });
  }
});

test('B2-T7: a recovered lease rejects its stale owner, retries a network outcome once, then durably settles success', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const first = await claimDelivery({
      store: setup.store,
      deliveryId: 'delivery-crash',
      now: NOW,
      leaseMs: 10,
      newAttemptId: () => 'attempt-1',
      newLeaseToken: () => 'token-1',
      assertAccountLive: async () => undefined,
    });
    assert.equal(first.kind, 'claimed');
    const recovered = await claimDelivery({
      store: setup.store,
      deliveryId: 'delivery-crash',
      now: NOW + 10,
      leaseMs: 10,
      newAttemptId: () => 'attempt-2',
      newLeaseToken: () => 'token-2',
      assertAccountLive: async () => undefined,
    });
    assert.equal(recovered.kind, 'claimed');
    assert.equal(
      await settleWebhookOutcome({
        store: setup.store,
        claim: first.claim,
        outcome: { kind: 'network' },
        now: NOW + 10,
      }),
      false,
    );
    assert.equal(
      await settleWebhookOutcome({
        store: setup.store,
        claim: { ...recovered.claim, leaseToken: 'test-stale-token' },
        outcome: { kind: 'network' },
        now: NOW + 10,
      }),
      false,
      'a token alone cannot settle a recovered attempt',
    );
    assert.equal(
      await settleWebhookOutcome({
        store: setup.store,
        claim: { ...recovered.claim, attemptId: 'forged-attempt' },
        outcome: { kind: 'network' },
        now: NOW + 10,
      }),
      false,
      'an attempt id alone cannot settle a recovered lease',
    );
    assert.equal(
      await settleWebhookOutcome({
        store: setup.store,
        claim: recovered.claim,
        outcome: { kind: 'network' },
        now: NOW + 10,
      }),
      true,
    );
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare(
            "SELECT state, attempts, last_error_code, last_status, next_at FROM deliveries WHERE id = 'delivery-crash'",
          )
          .get() as object),
      },
      {
        state: 'retryable',
        attempts: 2,
        last_error_code: 'NETWORK',
        last_status: null,
        next_at: 1_700_000_002_443,
      },
    );
    const retry = await claimDelivery({
      store: setup.store,
      deliveryId: 'delivery-crash',
      now: NOW + 3_000,
      leaseMs: 10,
      newAttemptId: () => 'attempt-3',
      newLeaseToken: () => 'token-3',
      assertAccountLive: async () => undefined,
    });
    assert.equal(retry.kind, 'claimed');
    assert.equal(
      await settleWebhookOutcome({
        store: setup.store,
        claim: retry.claim,
        outcome: { kind: 'response', status: 204, success: true },
        now: NOW + 3_000,
      }),
      true,
    );
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare("SELECT state, encrypted_record, attempts, last_status FROM deliveries WHERE id = 'delivery-crash'")
          .get() as object),
      },
      { state: 'delivered', encrypted_record: null, attempts: 3, last_status: 204 },
    );
    assert.equal(
      (setup.store.database.prepare('SELECT count(*) AS count FROM delivery_cap_charges').get() as { count: number })
        .count,
      1,
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T7: retry exhaustion dead-letters its still-retained record with one immutable deadline and one cap charge', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    let now = NOW;
    for (const attempt of [1, 2, 3]) {
      const claimed = await claimDelivery({
        store: setup.store,
        deliveryId: 'delivery-crash',
        now,
        leaseMs: 10,
        newAttemptId: () => `attempt-dead-${attempt}`,
        newLeaseToken: () => `test-dead-token-${attempt}`,
        assertAccountLive: async () => undefined,
      });
      assert.equal(claimed.kind, 'claimed');
      assert.equal(
        await settleWebhookOutcome({
          store: setup.store,
          claim: claimed.claim,
          outcome: { kind: 'network' },
          now,
        }),
        true,
      );
      if (attempt < 3) {
        now = (
          setup.store.database.prepare("SELECT next_at FROM deliveries WHERE id = 'delivery-crash'").get() as {
            next_at: number;
          }
        ).next_at;
      }
    }
    const deadLetter = setup.store.database
      .prepare(
        "SELECT state, attempts, encrypted_record, next_at, dead_lettered_at, dead_letter_expires_at FROM deliveries WHERE id = 'delivery-crash'",
      )
      .get() as {
      state: string;
      attempts: number;
      encrypted_record: Uint8Array | null;
      next_at: number | null;
      dead_lettered_at: number | null;
      dead_letter_expires_at: number | null;
    };
    assert.deepEqual(
      {
        state: deadLetter.state,
        attempts: deadLetter.attempts,
        next_at: deadLetter.next_at,
        dead_lettered_at: deadLetter.dead_lettered_at,
        dead_letter_expires_at: deadLetter.dead_letter_expires_at,
      },
      {
        state: 'dead-lettered',
        attempts: 3,
        next_at: null,
        dead_lettered_at: now,
        dead_letter_expires_at: now + 1_000,
      },
    );
    assert.ok(deadLetter.encrypted_record, 'dead-letter keeps the encrypted delivery record until its stored deadline');
    assert.equal(
      (setup.store.database.prepare('SELECT count(*) AS count FROM delivery_cap_charges').get() as { count: number })
        .count,
      1,
    );
    assert.deepEqual(
      await claimDelivery({
        store: setup.store,
        deliveryId: 'delivery-crash',
        now: now + 1,
        leaseMs: 10,
        newAttemptId: () => 'attempt-never',
        newLeaseToken: () => 'test-never-token',
        assertAccountLive: async () => undefined,
      }),
      { kind: 'terminal' },
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T7: disable winning after an issued request preserves its terminal state and records only a content-free discarded outcome', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const claimed = await claimDelivery({
      store: setup.store,
      deliveryId: 'delivery-crash',
      now: NOW,
      leaseMs: 10,
      newAttemptId: () => 'attempt-issued',
      newLeaseToken: () => 'token-issued',
      assertAccountLive: async () => undefined,
    });
    assert.equal(claimed.kind, 'claimed');
    await new EventLifecycle(setup.store, () => NOW + 1).disableAll();
    assert.equal(
      await settleWebhookOutcome({
        store: setup.store,
        claim: claimed.claim,
        outcome: { kind: 'response', status: 503, success: false },
        now: NOW + 1,
      }),
      false,
    );
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare(
            "SELECT state, encrypted_record, last_error_code, last_status, next_at FROM deliveries WHERE id = 'delivery-crash'",
          )
          .get() as object),
      },
      {
        state: 'in-flight-at-disable',
        encrypted_record: null,
        last_error_code: null,
        last_status: null,
        next_at: null,
      },
    );
    const attempts = (
      setup.store.database
        .prepare("SELECT code FROM work_attempts WHERE work_id = 'delivery-crash' ORDER BY id")
        .all() as Array<{ code: string }>
    ).map((row) => ({ ...row }));
    assert.deepEqual(attempts, [{ code: 'external-outcome-unrecalled-discarded' }]);
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T7: the concrete adapter owns its default durable outcome seam after a response', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    assert.deepEqual(await dispatcher(setup, { response: 204 }).dispatch('delivery-crash'), {
      state: 'issued',
      deliveryId: 'delivery-crash',
    });
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare("SELECT state, encrypted_record, last_status FROM deliveries WHERE id = 'delivery-crash'")
          .get() as object),
      },
      { state: 'delivered', encrypted_record: null, last_status: 204 },
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T7: a crash after outcome leaves a durable terminal row that no old attempt redispatches', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    await assert.rejects(
      dispatcher(setup, {
        response: 204,
        failpoint: (point) =>
          point === 'after-outcome' &&
          (() => {
            throw new Error('crash:after-outcome');
          })(),
      }).dispatch('delivery-crash'),
      /crash:after-outcome/,
    );
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare("SELECT state, encrypted_record, attempts FROM deliveries WHERE id = 'delivery-crash'")
          .get() as object),
      },
      { state: 'delivered', encrypted_record: null, attempts: 1 },
    );
    assert.deepEqual(await dispatcher(setup, { response: 204 }).dispatch('delivery-crash'), {
      state: 'terminal',
      deliveryId: 'delivery-crash',
    });
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T7: an after-write crash may issue a bounded duplicate but never another cap charge', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    await assert.rejects(
      dispatcher(setup, {
        response: 204,
        failpoint: (point) =>
          point === 'after-write' &&
          (() => {
            throw new Error('crash:after-write');
          })(),
      }).dispatch('delivery-crash'),
      /crash:after-write/,
    );
    assert.deepEqual(await dispatcher(setup, { response: 204, now: NOW + 30_000 }).dispatch('delivery-crash'), {
      state: 'issued',
      deliveryId: 'delivery-crash',
    });
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare("SELECT state, attempts FROM deliveries WHERE id = 'delivery-crash'")
          .get() as object),
      },
      { state: 'delivered', attempts: 2 },
    );
    assert.equal(
      (setup.store.database.prepare('SELECT count(*) AS count FROM delivery_cap_charges').get() as { count: number })
        .count,
      1,
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T7: a post-response account removal keeps its content-free removal winner and does not retry', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  let accountLive = true;
  try {
    assert.deepEqual(
      await dispatcher(setup, {
        response: 503,
        onResponse: () => {
          accountLive = false;
        },
        accountLive: () => accountLive,
      }).dispatch('delivery-crash'),
      { state: 'issued', deliveryId: 'delivery-crash' },
    );
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare("SELECT state, encrypted_record, next_at FROM deliveries WHERE id = 'delivery-crash'")
          .get() as object),
      },
      { state: 'in-flight-at-account-removal', encrypted_record: null, next_at: null },
    );
    assert.deepEqual(
      (
        setup.store.database.prepare("SELECT code FROM work_attempts WHERE work_id = 'delivery-crash'").all() as Array<{
          code: string;
        }>
      ).map((row) => ({ ...row })),
      [{ code: 'external-outcome-unrecalled-discarded' }],
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T7: a revocation wins a late response, while a superseded exact version remains deliverable', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  for (const scenario of [
    {
      name: 'revocation',
      mutate(setup: Awaited<ReturnType<typeof fixture>>) {
        setup.store.database.exec("UPDATE target_versions SET revoked_at = 2 WHERE target_id = 'target-crash'");
      },
      expected: { state: 'cancelled', encrypted_record: null },
      discarded: true,
    },
    {
      name: 'superseded version',
      mutate(setup: Awaited<ReturnType<typeof fixture>>) {
        setup.store.database.exec("UPDATE rule_versions SET state = 'superseded' WHERE rule_id = 'rule-crash'");
      },
      expected: { state: 'delivered', encrypted_record: null },
      discarded: false,
    },
  ] as const) {
    await t.test(scenario.name, async () => {
      const setup = await fixture();
      try {
        const claimed = await claimDelivery({
          store: setup.store,
          deliveryId: 'delivery-crash',
          now: NOW,
          leaseMs: 10,
          newAttemptId: () => 'attempt-race',
          newLeaseToken: () => 'test-race-token',
          assertAccountLive: async () => undefined,
        });
        assert.equal(claimed.kind, 'claimed');
        scenario.mutate(setup);
        assert.equal(
          await settleWebhookOutcome({
            store: setup.store,
            claim: claimed.claim,
            outcome: { kind: 'response', status: 204, success: true },
            now: NOW,
          }),
          scenario.discarded === false,
        );
        assert.deepEqual(
          {
            ...(setup.store.database
              .prepare("SELECT state, encrypted_record FROM deliveries WHERE id = 'delivery-crash'")
              .get() as object),
          },
          scenario.expected,
        );
        assert.equal(
          (
            setup.store.database
              .prepare("SELECT count(*) AS count FROM work_attempts WHERE work_id = 'delivery-crash'")
              .get() as {
              count: number;
            }
          ).count,
          scenario.discarded ? 1 : 0,
        );
      } finally {
        setup.store.close();
        await rm(setup.stateDir, { recursive: true, force: true });
      }
    });
  }
});

test('B2-T7: pause after write permits the already-issued response to settle without another request', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    assert.deepEqual(
      await dispatcher(setup, {
        response: 204,
        onResponse: () => {
          setup.store.database.exec('UPDATE event_settings SET paused = 1');
        },
      }).dispatch('delivery-crash'),
      { state: 'issued', deliveryId: 'delivery-crash' },
    );
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare("SELECT state, encrypted_record, next_at FROM deliveries WHERE id = 'delivery-crash'")
          .get() as object),
      },
      { state: 'delivered', encrypted_record: null, next_at: null },
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T7: an authority loss after the HTTP response never creates a retryable delivery', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  let fences = 0;
  try {
    assert.deepEqual(
      await dispatcher(setup, {
        response: 503,
        fence: async () => {
          fences += 1;
          if (fences === 6) throw new Error('authority revoked after write');
        },
      }).dispatch('delivery-crash'),
      { state: 'issued', deliveryId: 'delivery-crash' },
    );
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare("SELECT state, encrypted_record FROM deliveries WHERE id = 'delivery-crash'")
          .get() as object),
      },
      { state: 'cancelled', encrypted_record: null },
    );
    assert.deepEqual(
      (
        setup.store.database.prepare("SELECT code FROM work_attempts WHERE work_id = 'delivery-crash'").all() as Array<{
          code: string;
        }>
      ).map((row) => ({ ...row })),
      [{ code: 'external-outcome-unrecalled-discarded' }],
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});
