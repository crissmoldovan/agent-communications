import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { type SecretStore, TaintStore } from '@agentcomms/core';
import { gmailMessageReceivedV1, whatsappMessageReceivedV1 } from '@agentcomms/events';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { assertLiveEventAccount } from '../src/runtime/account-fence.ts';
import { commitHeldDecisionOutbox, StaleDecisionError } from '../src/runtime/decisions.ts';
import { EventEvaluator } from '../src/runtime/evaluate.ts';
import { claimHeldDecision, HoldResolver } from '../src/runtime/holds.ts';
import { JudgeCoordinator } from '../src/runtime/judge-coordinator.ts';
import { JudgeTransport } from '../src/runtime/judge-transport.ts';
import { type EventTaintRecorder, recordEventTaint } from '../src/runtime/untrusted.ts';
import { WhatsAppVisibilityFence } from '../src/runtime/whatsapp-visibility.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { openEventSecretStore, selectEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { testWriterQuiescer } from './support/writer-quiescer.ts';

const ACCOUNT = 'ibx_E8RACE';
const WHATSAPP_ACCOUNT = 'acc_ABCDEFGHIJKLMNOP';
const STAGED_AT = 1_800_000_000_000;

class MemorySecretStore implements SecretStore {
  readonly kind = 'file' as const;
  readonly #values = new Map<string, string>();
  async get(ref: string): Promise<string | null> {
    return this.#values.get(ref) ?? null;
  }
  async set(ref: string, value: string): Promise<void> {
    this.#values.set(ref, value);
  }
  async delete(ref: string): Promise<boolean> {
    return this.#values.delete(ref);
  }
  invalidate(): void {}
}

const target = { targetId: 'target-e8-race', version: 1, kind: 'dry-run' as const, retentionMs: 60_000 };
const judge = {
  judgeId: 'judge-e8-race',
  version: 1,
  kind: 'local-endpoint' as const,
  provider: 'ollama',
  model: 'nimble',
  endpoint: 'http://127.0.0.1:11434/v1/systemone',
  approvedAddressSet: ['127.0.0.1'] as const,
  promptTemplate: 'ollama-noul-v1',
  protocol: 'noul' as const,
};

function heldRule(
  input: Readonly<{
    threshold?: number;
    onUncertain?: 'hold' | 'no-match';
    source?: 'gmail' | 'whatsapp';
    accountId?: string;
  }> = {},
) {
  const source = input.source ?? 'gmail';
  const accountId = input.accountId ?? (source === 'whatsapp' ? WHATSAPP_ACCOUNT : ACCOUNT);
  const contentPointer = source === 'whatsapp' ? '/text' : '/subject';
  return {
    ruleId: 'rule-e8-race',
    version: 1,
    source: {
      channel: source,
      accountIds: [accountId],
      options:
        source === 'whatsapp'
          ? { channel: 'whatsapp' as const, chats: 'all-allowed' as const }
          : { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
    },
    event:
      source === 'whatsapp'
        ? { type: 'whatsapp.message.received', version: 1 }
        : { type: 'gmail.message.received', version: 1 },
    condition: { path: contentPointer, op: 'exists' },
    agentic: {
      judge,
      question: 'Does this synthetic message require a terminal decision?',
      inputs: [contentPointer],
      threshold: input.threshold ?? 0.5,
      onUncertain: input.onUncertain ?? 'hold',
      callsPerRollingHour: 10,
      inputTokensPerRolling30Days: 10_000,
      concurrency: 1,
      maxInputTokens: 10_000,
      maxOutputTokens: 64,
    },
    mapping: { content: { $path: contentPointer } },
    targets: [target],
    subscribers: [],
    judges: [],
    deliveryRateCap: 10,
    retention: {
      ingestMs: 60_000,
      holdMs: 60_000,
      deliveryMs: 60_000,
      dryrunMs: 60_000,
      sseReplayMs: 60_000,
      deadLetterMs: 60_000,
      decisionMetadataMs: 60_000,
    },
  };
}

function uncertainResponse(value: number): Buffer {
  return Buffer.from(
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"answers":{"decision":{"type":"noul","noul":${value}}},"model":"nimble","usage":{"input_tokens":9,"output_tokens":1}}`,
  );
}

function responseSocket(value = 0.45) {
  const listeners = new Map<string, (value?: Buffer | Error) => void>();
  return {
    write() {
      queueMicrotask(() => {
        listeners.get('data')?.(uncertainResponse(value));
        listeners.get('end')?.();
      });
      return true;
    },
    destroy() {},
    once(event: string, listener: (value?: Buffer | Error) => void) {
      listeners.set(event, listener);
      return this;
    },
    on(event: string, listener: (value?: Buffer | Error) => void) {
      listeners.set(event, listener);
      return this;
    },
  };
}

async function fixture(
  input: Readonly<{
    threshold?: number;
    responseValue?: number;
    stagedAt?: number;
    evaluatorNow?: number;
    source?: 'gmail' | 'whatsapp';
  }> = {},
) {
  const stagedAt = input.stagedAt ?? STAGED_AT;
  const evaluatorNow = input.evaluatorNow ?? STAGED_AT;
  const source = input.source ?? 'gmail';
  const accountId = source === 'whatsapp' ? WHATSAPP_ACCOUNT : ACCOUNT;
  const stateDir = await shortTempDir('events-e8-race-');
  const store = await openEventDatabase({ stateDir });
  store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 8 WHERE singleton = 1');
  await selectEventSecretStore(store.database, 'file');
  const secrets = await openEventSecretStore({
    database: store.database,
    paths: store.paths,
    configDir: '/srv/config',
    stores: { file: new MemorySecretStore() },
  });
  const cipher = new EventRecordCipher(store.database, secrets, testWriterQuiescer());
  const versions = new ImmutableVersions(store.database);
  const rule = heldRule({
    ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
    source,
    accountId,
  });
  versions.createTarget(target);
  versions.createJudge(judge);
  versions.createJudgeKind({ id: 'judge-kind:local-endpoint', kind: 'local-endpoint', version: 1 });
  versions.createJudgeBudget({
    budgetId: 'judge-budget',
    version: 1,
    global: { callsPerRollingHour: 10, inputTokensPerRolling30Days: 10_000, concurrency: 1 },
    providers: [{ provider: 'ollama', callsPerRollingHour: 10, inputTokensPerRolling30Days: 10_000, concurrency: 1 }],
  });
  versions.createRule(rule);
  store.database.exec(
    `INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
       VALUES ('judge-kind', 'local-endpoint', 1, 'kind-e8', ${STAGED_AT}),
              ('judge-budget', 'judge-budget', 1, 'budget-e8', ${STAGED_AT});
     UPDATE rule_versions
        SET state = 'active', approval_id = 'approval-e8', authorization_activation_id = 'activation-e8', activated_at = ${STAGED_AT}
      WHERE rule_id = 'rule-e8-race' AND version = 1;`,
  );
  const event =
    source === 'whatsapp'
      ? {
          ...whatsappMessageReceivedV1.examples[0],
          id: 'e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8',
          account: { name: 'Synthetic', id: accountId, channel: 'whatsapp' as const },
          workspaceId: accountId,
          text: 'synthetic WhatsApp content',
        }
      : {
          ...gmailMessageReceivedV1.examples[1],
          id: 'e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8',
          account: { name: 'Synthetic', id: accountId, channel: 'gmail' as const },
          subject: 'sender@example.test asks a synthetic question',
          from: { address: 'sender@example.test', name: 'Synthetic Sender' },
        };
  store.database
    .prepare(
      "INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES (?, ?, ?, 1, ?, 'e8-race', ?, ?, ?)",
    )
    .run(event.id, store.installationId, String(event.type), accountId, stagedAt, stagedAt, stagedAt);
  const whatsapp = source === 'whatsapp' ? { messageId: String(event.messageId), visibilityVersion: 1 } : undefined;
  if (whatsapp !== undefined) {
    store.database
      .prepare('INSERT INTO whatsapp_visibility (account_id, version, lists_digest, changed_at) VALUES (?, 1, ?, ?)')
      .run(accountId, 'a'.repeat(64), stagedAt);
    store.database
      .prepare(
        `INSERT INTO whatsapp_occurrences
          (account_id, message_id, first_seen_generation, first_seen_at, visibility_version, event_id)
         VALUES (?, ?, 1, ?, 1, ?)`,
      )
      .run(accountId, whatsapp.messageId, stagedAt, event.id);
  }
  const taintStore = new TaintStore(stateDir, () => new Date(stagedAt));
  const taint: EventTaintRecorder = {
    record: (input) => recordEventTaint(taintStore, { ownAddresses: [], internalDomains: [] }, input),
  };
  let ids = 0;
  const coordinator = new JudgeCoordinator({
    store,
    taint,
    now: () => evaluatorNow,
    newId: () => `e8-reservation-${++ids}`,
    transport: new JudgeTransport({ tcpConnect: async () => responseSocket(input.responseValue) as never }),
  });
  const evaluator = new EventEvaluator({
    store,
    cipher,
    taint,
    now: () => evaluatorNow,
    newId: () => `e8-decision-${++ids}`,
    fence: async () => ({
      approvalId: 'approval-e8',
      authorizationActivationId: 'activation-e8',
      usedAt: 'synthetic',
      switchGeneration: 8,
    }),
    judgeCoordinator: coordinator,
  });
  assert.equal(
    await evaluator.admit({
      event,
      eventId: event.id,
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
      stagedAt,
      ...(whatsapp === undefined ? {} : { whatsapp }),
    }),
    'terminal',
  );
  const decisionId = (store.database.prepare('SELECT id FROM decisions').get() as { id: string }).id;
  return { stateDir, store, cipher, taint, decisionId, accountId, whatsapp };
}

test('E8 P1: a stale evaluator clock cannot create a hold past its SQLite ingest deadline', {
  skip: WINDOWS_SKIP,
}, async () => {
  // The evaluator's process clock is before its retained projection deadline, while SQLite's transaction clock is
  // long after stagedAt + ingestMs. The final decision transaction, rather than the stale early check, owns expiry.
  const setup = await fixture({ stagedAt: 0, evaluatorNow: -1 });
  try {
    const decision = setup.store.database
      .prepare('SELECT outcome, hold_expires_at FROM decisions WHERE id = ?')
      .get(setup.decisionId) as { outcome: string; hold_expires_at: number | null };
    assert.equal(decision.outcome, 'retention-expired');
    assert.equal(decision.hold_expires_at, null);
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as { count: number }).count,
      0,
      'the terminal transaction purges the projection instead of retaining an already-expired hold',
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('E8 P1: a fast evaluator clock cannot expire a hold before its SQLite ingest deadline', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stagedAt = Date.now();
  const setup = await fixture({ stagedAt, evaluatorNow: stagedAt + 120_000 });
  try {
    const decision = setup.store.database
      .prepare('SELECT outcome, hold_expires_at FROM decisions WHERE id = ?')
      .get(setup.decisionId) as { outcome: string; hold_expires_at: number | null };
    assert.equal(decision.outcome, 'hold');
    assert.notEqual(decision.hold_expires_at, null, 'SQLite has not reached the durable ingest deadline');
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

function resolverFor(
  setup: Awaited<ReturnType<typeof fixture>>,
  authorise?: () => Promise<void>,
  decisionFailpoint?: (
    point: 'after-settlement' | 'after-decision' | 'after-delivery' | 'after-projection-purge' | 'before-commit',
  ) => void,
  options: Readonly<{
    whatsappVisibilityFence?: WhatsAppVisibilityFence;
    accountLive?: (input: { source: 'gmail' | 'whatsapp'; accountId: string }) => Promise<void>;
  }> = {},
): HoldResolver {
  return new HoldResolver({
    store: setup.store,
    cipher: setup.cipher,
    taint: setup.taint,
    leaseMs: 30_000,
    newId: (() => {
      let id = 0;
      return () => `e8-delivery-${++id}`;
    })(),
    decisionFailpoint,
    accountLive: options.accountLive ?? (async () => undefined),
    authorise: async () => {
      await authorise?.();
      return {
        approvalId: 'approval-e8',
        authorizationActivationId: 'activation-e8',
        usedAt: 'synthetic',
        switchGeneration: 8,
      };
    },
    ...(options.whatsappVisibilityFence === undefined
      ? {}
      : { whatsappVisibilityFence: options.whatsappVisibilityFence }),
  } as never);
}

test('E8 P1: held WhatsApp resolution applies the shared live-list fence before it reads retained content', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture({ source: 'whatsapp' });
  try {
    const fence = new WhatsAppVisibilityFence({
      store: setup.store,
      withCurrentEventVisibility: async (_input, work) =>
        work({ version: 2, digest: 'b'.repeat(64), seesMessage: () => false }),
    });
    assert.deepEqual(
      await resolverFor(setup, undefined, undefined, { whatsappVisibilityFence: fence }).resolve({
        decisionId: setup.decisionId,
        decision: 'accept',
      }),
      { kind: 'stale' },
    );
    const decision = setup.store.database
      .prepare('SELECT outcome, encrypted_record FROM decisions WHERE id = ?')
      .get(setup.decisionId) as { outcome: string; encrypted_record: Uint8Array | null };
    assert.equal(decision.outcome, 'cancelled');
    assert.equal(decision.encrypted_record, null);
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as { count: number }).count,
      0,
      'the live-list journal applies its hidden-content purge before the resolver can decrypt or map',
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('E8 P2: held WhatsApp resolution commits against the journal head after a visible list change', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture({ source: 'whatsapp' });
  try {
    const fence = new WhatsAppVisibilityFence({
      store: setup.store,
      // `version` belongs to WhatsApp's file format. It deliberately remains stable while a changed digest advances
      // the daemon-owned visibility journal from 1 to 2.
      withCurrentEventVisibility: async (_input, work) =>
        work({ version: 1, digest: 'b'.repeat(64), seesMessage: () => true }),
    });
    assert.deepEqual(
      await resolverFor(setup, undefined, undefined, { whatsappVisibilityFence: fence }).resolve({
        decisionId: setup.decisionId,
        decision: 'accept',
      }),
      { kind: 'resolved', outcome: 'matched' },
    );
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare('SELECT version, lists_digest FROM whatsapp_visibility WHERE account_id = ?')
          .get(setup.accountId) as Record<string, unknown>),
      },
      { version: 2, lists_digest: 'b'.repeat(64) },
      "the final held-resolution fence compares the journal head, not WhatsApp's file-format version",
    );
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as { count: number }).count,
      1,
      'the still-visible held decision resolves through its sole delivery path exactly once',
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('E8 P1: held resolution rechecks the live account after delivery encryption and taint before its final write', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  let accountPresent = true;
  let authorisations = 0;
  const config = {
    load: async () => ({
      inboxes: accountPresent ? { synthetic: { id: ACCOUNT, provider: 'gmail' } } : {},
      accounts: {},
    }),
  };
  try {
    const resolver = resolverFor(
      setup,
      async () => {
        authorisations += 1;
        if (authorisations === 2) accountPresent = false;
      },
      undefined,
      {
        accountLive: ({ source, accountId }) => assertLiveEventAccount(config as never, { source, accountId }),
      },
    );
    assert.deepEqual(await resolver.resolve({ decisionId: setup.decisionId, decision: 'accept' }), { kind: 'stale' });
    const decision = setup.store.database
      .prepare('SELECT outcome, encrypted_record FROM decisions WHERE id = ?')
      .get(setup.decisionId) as { outcome: string; encrypted_record: Uint8Array | null };
    assert.equal(decision.outcome, 'cancelled');
    assert.equal(decision.encrypted_record, null);
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as { count: number }).count,
      0,
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('E8: competing terminal/app resolvers use one held decision, one claim and one encrypted delivery path', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const resolver = resolverFor(setup);
    const outcomes = await Promise.all([
      resolver.resolve({ decisionId: setup.decisionId, decision: 'accept' }),
      resolver.resolve({ decisionId: setup.decisionId, decision: 'accept' }),
    ]);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.kind).sort(),
      ['busy', 'resolved'],
      'exactly one resolver owns the random DB lease',
    );
    assert.equal(
      (
        setup.store.database.prepare('SELECT outcome FROM decisions WHERE id = ?').get(setup.decisionId) as {
          outcome: string;
        }
      ).outcome,
      'matched',
    );
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as { count: number }).count,
      1,
    );
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM hold_resolution_claims').get() as { count: number })
        .count,
      0,
      'the final decision transaction consumes the exact claim token',
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('E8: the production coordinator has closed threshold 0, 1, and uncertain-band boundaries', {
  skip: WINDOWS_SKIP,
}, async (context) => {
  const cases: readonly [string, number, number, 'matched' | 'hold' | 'no-match'][] = [
    ['zero accepts the lowest valid Noul value', 0, 0, 'matched'],
    ['one accepts only the highest valid Noul value', 1, 1, 'matched'],
    ['the lower uncertain-band boundary holds', 0.5, 0.4, 'hold'],
    ['below the uncertain band closes no-match', 0.5, 0.399, 'no-match'],
  ];
  for (const [name, threshold, responseValue, expected] of cases) {
    await context.test(name, async () => {
      const setup = await fixture({ threshold, responseValue });
      try {
        assert.equal(
          (
            setup.store.database.prepare('SELECT outcome FROM decisions WHERE id = ?').get(setup.decisionId) as {
              outcome: string;
            }
          ).outcome,
          expected,
        );
      } finally {
        setup.store.close();
        await rm(setup.stateDir, { recursive: true, force: true });
      }
    });
  }
});

test('E8: resolution rechecks its authority after decrypt and refuses a disabled hold without a delivery', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    let checks = 0;
    const resolver = resolverFor(setup, async () => {
      checks += 1;
      if (checks === 2) setup.store.database.exec('UPDATE event_settings SET paused = 1 WHERE singleton = 1');
    });
    assert.deepEqual(await resolver.resolve({ decisionId: setup.decisionId, decision: 'accept' }), { kind: 'stale' });
    assert.equal(
      (
        setup.store.database.prepare('SELECT outcome FROM decisions WHERE id = ?').get(setup.decisionId) as {
          outcome: string;
        }
      ).outcome,
      'hold',
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

test('E8: final hold resolution refuses a mismatched decision-bound claim token before any delivery write', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const claimed = claimHeldDecision({ store: setup.store, decisionId: setup.decisionId, leaseMs: 30_000 });
    assert.equal(claimed.kind, 'claimed');
    if (claimed.kind !== 'claimed') throw new Error('the fixture must own one claim');
    const wrongToken = Buffer.from(claimed.claim.claimToken);
    wrongToken[0] = wrongToken[0] === 0 ? 1 : 0;
    assert.throws(
      () =>
        commitHeldDecisionOutbox(setup.store, {
          id: setup.decisionId,
          eventId: 'e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8',
          accountId: ACCOUNT,
          ruleId: 'rule-e8-race',
          ruleVersion: 1,
          claimToken: wrongToken,
          outcome: 'no-match',
          switchGeneration: 8,
          deliveries: [],
          disclosure: { approvalId: 'approval-e8', authorizationActivationId: 'activation-e8' },
        }),
      StaleDecisionError,
    );
    assert.equal(
      (
        setup.store.database.prepare('SELECT outcome FROM decisions WHERE id = ?').get(setup.decisionId) as {
          outcome: string;
        }
      ).outcome,
      'hold',
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

test('E8: resolver transaction crash points leave one recoverable held decision and no partial delivery', {
  skip: WINDOWS_SKIP,
}, async (context) => {
  for (const point of ['after-decision', 'after-delivery', 'after-projection-purge'] as const) {
    await context.test(point, async () => {
      const setup = await fixture();
      try {
        const resolver = resolverFor(setup, undefined, (current) => {
          if (current === point) throw new Error(`crash:${point}`);
        });
        await assert.rejects(
          () => resolver.resolve({ decisionId: setup.decisionId, decision: 'accept' }),
          new RegExp(`crash:${point}`),
        );
        assert.equal(
          (
            setup.store.database.prepare('SELECT outcome FROM decisions WHERE id = ?').get(setup.decisionId) as {
              outcome: string;
            }
          ).outcome,
          'hold',
        );
        assert.equal(
          (setup.store.database.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as { count: number }).count,
          0,
        );
        assert.equal(
          (setup.store.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as { count: number }).count,
          1,
        );
        assert.equal(
          (
            setup.store.database.prepare('SELECT COUNT(*) AS count FROM hold_resolution_claims').get() as {
              count: number;
            }
          ).count,
          1,
          'the separately committed DB lease remains recoverable after the final transaction rolls back',
        );
      } finally {
        setup.store.close();
        await rm(setup.stateDir, { recursive: true, force: true });
      }
    });
  }
});
