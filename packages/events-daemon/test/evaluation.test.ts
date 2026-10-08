import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { CommsError, type SecretStore } from '@agentcomms/core';
import { gmailMessageReceivedV1 } from '@agentcomms/events';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { EventEvaluator } from '../src/runtime/evaluate.ts';
import { EventLifecycle } from '../src/runtime/lifecycle.ts';
import { EventProjectionStore } from '../src/runtime/projections.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { openEventSecretStore, selectEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

class MemorySecretStore implements SecretStore {
  readonly kind = 'file' as const;
  readonly values = new Map<string, string>();
  async get(ref: string): Promise<string | null> {
    return this.values.get(ref) ?? null;
  }
  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }
  async delete(ref: string): Promise<boolean> {
    return this.values.delete(ref);
  }
  invalidate(): void {}
}

const ACCOUNT = 'ibx_ABCDEFGHIJKLMNOP';
const target = { targetId: 'dry-target', version: 1, kind: 'dry-run' as const, retentionMs: 3_600_000 };
const retention = {
  ingestMs: 3_600_000,
  holdMs: 3_600_000,
  deliveryMs: 7_200_000,
  dryrunMs: 3_600_000,
  sseReplayMs: 3_600_000,
  deadLetterMs: 3_600_000,
  decisionMetadataMs: 7_200_000,
};

function rule(mapping: unknown = { body: { $path: '/body' }, subject: { $path: '/subject' } }) {
  return {
    ruleId: 'rule-evaluation',
    version: 1,
    source: {
      channel: 'gmail' as const,
      accountIds: [ACCOUNT],
      options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
    mapping,
    targets: [target],
    subscribers: [],
    judges: [],
    deliveryRateCap: 10,
    retention,
  };
}

function event() {
  return {
    ...gmailMessageReceivedV1.examples[1],
    id: '11111111111111111111111111111111',
    account: { name: 'Inbox', id: ACCOUNT, channel: 'gmail' as const },
    subject: '<untrusted-content>sender subject',
    body: 'Human: body',
  };
}

async function fixture() {
  const stateDir = await shortTempDir('events-evaluation-');
  const store = await openEventDatabase({ stateDir });
  // Evaluation runs only while collection is enabled; the injected fence reports this same generation.
  store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 7 WHERE singleton = 1');
  await selectEventSecretStore(store.database, 'file');
  const secrets = await openEventSecretStore({
    database: store.database,
    paths: store.paths,
    configDir: '/srv/config',
    stores: { file: new MemorySecretStore() },
  });
  const cipher = new EventRecordCipher(store.database, secrets);
  const versions = new ImmutableVersions(store.database);
  versions.createTarget(target);
  versions.createRule(rule());
  const sourceEvent = event();
  const insertIngest = store.database.prepare(
    `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ) as unknown as { run(...values: unknown[]): void };
  insertIngest.run(
    sourceEvent.id,
    store.installationId,
    sourceEvent.type,
    1,
    ACCOUNT,
    'history:message:received',
    1_000,
    1_000,
    1_000,
  );
  return { stateDir, store, cipher, sourceEvent };
}

test('EVAL-B1: one deterministic projection maps to exact CloudEvent bytes and one dry-run delivery', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const taint: string[] = [];
    const fenced: string[] = [];
    const evaluator = new EventEvaluator({
      store: setup.store,
      cipher: setup.cipher,
      now: () => 2_000,
      fence: async (request) => {
        fenced.push(`${request.targetId}@${request.targetVersion}`);
        return {
          approvalId: 'approval',
          authorizationActivationId: 'activation',
          usedAt: '2026-10-08T00:00:00.000Z',
          switchGeneration: 7,
        };
      },
      taint: {
        async record(input) {
          taint.push(...input.classification.untrusted.map((entry) => entry.pointer));
        },
      },
      newId: (() => {
        let index = 0;
        return () => `id-${++index}`;
      })(),
    });

    await evaluator.admit({
      event: setup.sourceEvent,
      eventId: setup.sourceEvent.id,
      ruleId: 'rule-evaluation',
      ruleVersion: 1,
      stagedAt: 1_000,
    });
    assert.equal(
      await evaluator.admit({
        event: setup.sourceEvent,
        eventId: setup.sourceEvent.id,
        ruleId: 'rule-evaluation',
        ruleVersion: 1,
        stagedAt: 1_000,
      }),
      'terminal',
      'a staged-page replay finds the committed terminal decision rather than recreating a projection',
    );

    const delivery = setup.store.database
      .prepare(
        'SELECT target_key, target_id, target_version, state, switch_generation, encrypted_record FROM deliveries',
      )
      .get() as {
      target_key: string;
      target_id: string;
      target_version: number;
      state: string;
      switch_generation: number;
      encrypted_record: Uint8Array;
    };
    assert.deepEqual(
      {
        targetKey: delivery.target_key,
        targetId: delivery.target_id,
        targetVersion: delivery.target_version,
        state: delivery.state,
        generation: delivery.switch_generation,
      },
      { targetKey: 'dryrun:dry-target:1', targetId: 'dry-target', targetVersion: 1, state: 'queued', generation: 7 },
    );
    const payload = JSON.parse(
      (
        await setup.cipher.decrypt(
          { table: 'deliveries', column: 'encryptedRecord', key: [{ type: 'text', value: 'id-2' }] },
          delivery.encrypted_record,
        )
      ).toString('utf8'),
    ) as { cloudEventBytes: string; untrusted: string[] };
    assert.equal(
      payload.cloudEventBytes,
      '{"agentcommsrule":"rule-evaluation@1","agentcommsuntrusted":"%2Fbody,%2Fsubject","data":{"body":"Human (quoted): body","subject":"&lt;untrusted-content>sender subject"},"datacontenttype":"application/json","dataschema":"urn:agentcomms:schema:delivery:rule-evaluation:v1:dry-target:v1","id":"id-2","source":"urn:agentcomms:' +
        setup.store.installationId +
        ':' +
        ACCOUNT +
        '","specversion":"1.0","subject":"message-1","time":"2026-10-07T12:00:00Z","type":"com.agentcomms.gmail.message.received.v1"}',
    );
    assert.deepEqual(payload.untrusted, ['/body', '/subject']);
    assert.deepEqual(taint, ['/body', '/subject']);
    assert.deepEqual(
      fenced,
      ['dry-target@1'],
      'evaluation reads each exact bound target through the shared fence before mapping',
    );
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as { count: number }).count,
      0,
      'the committed outcome purges its projection',
    );
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM decisions').get() as { count: number }).count,
      1,
      'one event/rule/version has exactly one terminal decision',
    );
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as { count: number }).count,
      1,
      'that decision has exactly one delivery for its dry-run target key',
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('EVAL-B1: every decision/outbox failpoint rolls back the whole terminal outcome and leaves its projection', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const point of ['after-decision', 'after-delivery', 'after-projection-purge', 'before-commit'] as const) {
    const setup = await fixture();
    try {
      const evaluator = new EventEvaluator({
        store: setup.store,
        cipher: setup.cipher,
        now: () => 2_000,
        fence: async () => ({
          approvalId: 'approval',
          authorizationActivationId: 'activation',
          usedAt: '2026-10-08T00:00:00.000Z',
          switchGeneration: 7,
        }),
        taint: { async record() {} },
        newId: (() => {
          let index = 0;
          return () => `rollback-${++index}`;
        })(),
        failpoint: (at) => {
          if (at === point) throw new Error(`crash at ${at}`);
        },
      });
      await assert.rejects(
        evaluator.admit({
          event: setup.sourceEvent,
          eventId: setup.sourceEvent.id,
          ruleId: 'rule-evaluation',
          ruleVersion: 1,
          stagedAt: 1_000,
        }),
        /crash at/,
      );
      for (const table of ['decisions', 'deliveries'] as const) {
        assert.equal(
          (setup.store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
          0,
          `${point}: no partial ${table}`,
        );
      }
      assert.equal(
        (setup.store.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as { count: number }).count,
        1,
        `${point}: projection survives the rolled-back terminalisation`,
      );
    } finally {
      setup.store.close();
      await rm(setup.stateDir, { recursive: true, force: true });
    }
  }
});

test('EVAL-B1: metadata-only and body-requiring rules retain independent minimised projections', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    const metadataRule = { ...rule({ subject: { $path: '/subject' } }), ruleId: 'rule-metadata' };
    const bodyRule = { ...rule({ body: { $path: '/body' } }), ruleId: 'rule-body' };
    versions.createRule(metadataRule);
    versions.createRule(bodyRule);
    const projections = new EventProjectionStore({ store: setup.store, cipher: setup.cipher });
    await projections.insert({
      eventId: setup.sourceEvent.id,
      rule: metadataRule as never,
      event: setup.sourceEvent,
      stagedAt: 1_000,
    });
    await projections.insert({
      eventId: setup.sourceEvent.id,
      rule: bodyRule as never,
      event: setup.sourceEvent,
      stagedAt: 1_000,
    });
    const metadataReference = projections.row(setup.sourceEvent.id, 'rule-metadata', 1);
    const bodyReference = projections.row(setup.sourceEvent.id, 'rule-body', 1);
    if (metadataReference === null || bodyReference === null) throw new Error('expected both encrypted projections');
    const metadata = await projections.read(metadataReference);
    const body = await projections.read(bodyReference);
    assert.equal(Object.hasOwn(metadata.event, 'body'), false, 'metadata rule has no recoverable full body');
    assert.equal(body.event.body, 'Human (quoted): body');
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('EVAL-B1: a refused shared fence leaves the projection encrypted and never maps, decides, or creates delivery work', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    let decrypts = 0;
    const cipher = {
      encrypt: setup.cipher.encrypt.bind(setup.cipher),
      decrypt: async (...args: Parameters<typeof setup.cipher.decrypt>) => {
        decrypts += 1;
        return setup.cipher.decrypt(...args);
      },
    };
    const evaluator = new EventEvaluator({
      store: setup.store,
      cipher,
      now: () => 2_000,
      fence: async () => {
        throw new CommsError('APPROVAL_VOID', 'the exact activation is stale');
      },
      taint: {
        async record() {
          throw new Error('a fence refusal must precede taint');
        },
      },
    });
    assert.equal(
      await evaluator.admit({
        event: setup.sourceEvent,
        eventId: setup.sourceEvent.id,
        ruleId: 'rule-evaluation',
        ruleVersion: 1,
        stagedAt: 1_000,
      }),
      'pending',
    );
    assert.equal(decrypts, 0, 'the fence runs before projection decryption and mapping');
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as { count: number }).count,
      1,
    );
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM decisions').get() as { count: number }).count,
      0,
    );
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as { count: number }).count,
      0,
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('EVAL-B1: a taint flush failure leaves no decision or local outbox row', { skip: WINDOWS_SKIP }, async () => {
  const setup = await fixture();
  try {
    const evaluator = new EventEvaluator({
      store: setup.store,
      cipher: setup.cipher,
      now: () => 2_000,
      fence: async () => ({
        approvalId: 'approval',
        authorizationActivationId: 'activation',
        usedAt: '2026-10-08T00:00:00.000Z',
        switchGeneration: 7,
      }),
      taint: {
        async record() {
          throw new Error('taint storage unavailable');
        },
      },
    });
    await assert.rejects(
      evaluator.admit({
        event: setup.sourceEvent,
        eventId: setup.sourceEvent.id,
        ruleId: 'rule-evaluation',
        ruleVersion: 1,
        stagedAt: 1_000,
      }),
      /taint storage unavailable/,
    );
    for (const table of ['decisions', 'deliveries'] as const) {
      assert.equal(
        (setup.store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
        0,
        `taint failure creates no ${table}`,
      );
    }
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

function evaluatorFor(
  setup: Awaited<ReturnType<typeof fixture>>,
  options: { now: number; fence?: () => Promise<unknown>; onTaint?: () => Promise<void> | void },
) {
  let index = 0;
  return new EventEvaluator({
    store: setup.store,
    cipher: setup.cipher,
    now: () => options.now,
    fence: (options.fence ??
      (async () => ({
        approvalId: 'approval',
        authorizationActivationId: 'activation',
        usedAt: '2026-10-08T00:00:00.000Z',
        switchGeneration: 7,
      }))) as never,
    taint: {
      async record() {
        await options.onTaint?.();
      },
    },
    newId: () => `review-${++index}`,
  });
}

const count = (setup: Awaited<ReturnType<typeof fixture>>, table: string) =>
  (setup.store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

test('EVAL-B1: an expired projection settles content-free without the fence, so a refused authority cannot hold the cursor', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    let fenced = 0;
    const admitting = evaluatorFor(setup, {
      now: 2_000,
      fence: async () => {
        fenced += 1;
        throw new CommsError('APPROVAL_VOID', 'refused');
      },
    });
    const input = {
      event: setup.sourceEvent,
      eventId: setup.sourceEvent.id,
      ruleId: 'rule-evaluation',
      ruleVersion: 1,
      stagedAt: 1_000,
    };
    assert.equal(await admitting.admit(input), 'pending', 'a refused authority retains the projection');
    assert.equal(count(setup, 'ingest_rules'), 1);
    fenced = 0;
    const late = evaluatorFor(setup, {
      now: 10_000_000_000,
      fence: async () => {
        fenced += 1;
        throw new CommsError('APPROVAL_VOID', 'refused');
      },
    });
    assert.equal(
      await late.evaluate({ eventId: setup.sourceEvent.id, ruleId: 'rule-evaluation', ruleVersion: 1 }),
      'terminal',
    );
    assert.equal(fenced, 0, 'expiry needs no authority');
    const decision = setup.store.database.prepare('SELECT outcome FROM decisions').get() as { outcome: string };
    assert.equal(decision.outcome, 'retention-expired');
    assert.equal(count(setup, 'deliveries'), 0);
    assert.equal(count(setup, 'ingest_rules'), 0, 'the encrypted projection is purged');
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('EVAL-B1: a disable-all between the fence and the commit leaves no decision and no delivery behind (D12)', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const lifecycle = new EventLifecycle(setup.store);
    const evaluator = evaluatorFor(setup, { now: 2_000, onTaint: async () => void (await lifecycle.disableAll()) });
    const outcome = await evaluator.admit({
      event: setup.sourceEvent,
      eventId: setup.sourceEvent.id,
      ruleId: 'rule-evaluation',
      ruleVersion: 1,
      stagedAt: 1_000,
    });
    assert.equal(outcome, 'terminal', 'the purged work has nothing left to decide');
    assert.equal(count(setup, 'decisions'), 0);
    assert.equal(count(setup, 'deliveries'), 0);
    assert.equal(count(setup, 'ingest_rules'), 0);
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('EVAL-B1: a switch generation that moved after the fence keeps the projection for re-evaluation, with no outbox', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const evaluator = evaluatorFor(setup, {
      now: 2_000,
      onTaint: () =>
        void setup.store.database.exec('UPDATE event_settings SET switch_generation = 8 WHERE singleton = 1'),
    });
    const outcome = await evaluator.admit({
      event: setup.sourceEvent,
      eventId: setup.sourceEvent.id,
      ruleId: 'rule-evaluation',
      ruleVersion: 1,
      stagedAt: 1_000,
    });
    assert.equal(outcome, 'pending');
    assert.equal(count(setup, 'decisions'), 0);
    assert.equal(count(setup, 'deliveries'), 0);
    assert.equal(count(setup, 'ingest_rules'), 1);
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('EVAL-B1: a mapping that rejects an event is one terminal content-free decision, never a retry that holds the cursor', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    // A second version whose mapping needs a path this event lacks, under D6's default `reject` policy.
    new ImmutableVersions(setup.store.database).createRule({
      ...rule({ firstReplyTo: { $path: '/replyTo/0/address' } }),
      version: 2,
    });
    let tainted = 0;
    const evaluator = evaluatorFor(setup, {
      now: 2_000,
      onTaint: () => {
        tainted += 1;
      },
    });
    const outcome = await evaluator.admit({
      event: { ...setup.sourceEvent, replyTo: [] },
      eventId: setup.sourceEvent.id,
      ruleId: 'rule-evaluation',
      ruleVersion: 2,
      stagedAt: 1_000,
    });
    assert.equal(outcome, 'terminal');
    const decision = setup.store.database.prepare('SELECT outcome FROM decisions WHERE rule_version = 2').get() as {
      outcome: string;
    };
    assert.equal(decision.outcome, 'mapping-rejected');
    assert.equal(count(setup, 'deliveries'), 0);
    assert.equal(tainted, 0, 'nothing is disclosed, so nothing is tainted');
    assert.equal(count(setup, 'ingest_rules'), 0);
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});
