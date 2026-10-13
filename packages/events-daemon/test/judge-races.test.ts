import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { canonicalJson, type SecretStore, TaintStore } from '@agentcomms/core';
import { gmailMessageReceivedV1, whatsappMessageReceivedV1 } from '@agentcomms/events';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { assertLiveEventAccount, purgeRemovedAccountWork } from '../src/runtime/account-fence.ts';
import { B3OperatorControl } from '../src/runtime/b3-operator-control.ts';
import { commitHeldDecisionOutbox, StaleDecisionError } from '../src/runtime/decisions.ts';
import { EventEvaluator } from '../src/runtime/evaluate.ts';
import { EventExpiry } from '../src/runtime/expiry.ts';
import { claimHeldDecision, expireHeldDecisions, HoldResolver } from '../src/runtime/holds.ts';
import { JudgeCoordinator } from '../src/runtime/judge-coordinator.ts';
import { JudgeTransport } from '../src/runtime/judge-transport.ts';
import { removeTarget } from '../src/runtime/revocations.ts';
import { type EventTaintRecorder, recordEventTaint } from '../src/runtime/untrusted.ts';
import { WhatsAppVisibilityFence } from '../src/runtime/whatsapp-visibility.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { openEventSecretStore, selectEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { testWriterQuiescer } from './support/writer-quiescer.ts';

/**
 * The lasting handles a test may leak — sockets, pipes, timers, child processes, servers. One-shot requests (a file
 * system read, a DNS lookup, a pending write) can be in flight at either snapshot without anything having leaked, so
 * they are left out of the before/after comparison.
 */
function lastingResources(): string[] {
  return process
    .getActiveResourcesInfo()
    .filter((name) => !/Req|^WriteWrap$|^ShutdownWrap$/u.test(name))
    .sort();
}

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
  let transportCalls = 0;
  const coordinator = new JudgeCoordinator({
    store,
    taint,
    now: () => evaluatorNow,
    newId: () => `e8-reservation-${++ids}`,
    transport: new JudgeTransport({
      tcpConnect: async () => {
        transportCalls += 1;
        return responseSocket(input.responseValue) as never;
      },
    }),
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
  return { stateDir, store, cipher, taint, decisionId, accountId, whatsapp, transportCalls: () => transportCalls };
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

function assertExpiredHeldDecision(
  setup: Readonly<{
    store: Awaited<ReturnType<typeof openEventDatabase>>;
    decisionId: string;
  }>,
  label: string,
): void {
  const decision = setup.store.database
    .prepare('SELECT outcome, encrypted_record FROM decisions WHERE id = ?')
    .get(setup.decisionId) as { outcome: string; encrypted_record: Uint8Array | null };
  assert.equal(decision.outcome, 'hold-expired', `${label}: the held decision reaches its exact terminal outcome`);
  assert.equal(decision.encrypted_record, null, `${label}: expiry erases the retained decision ciphertext`);
  assert.equal(
    (setup.store.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as { count: number }).count,
    0,
    `${label}: expiry purges the retained projection`,
  );
}

async function holdExpiryFixture(label: string) {
  const stateDir = await shortTempDir(`events-e12-hold-expiry-${label}-`);
  const store = await openEventDatabase({ stateDir });
  const versions = new ImmutableVersions(store.database);
  versions.createTarget(target);
  versions.createJudge(judge);
  versions.createRule(heldRule());
  const eventId = `event-e12-hold-expiry-${label}`;
  const decisionId = `decision-e12-hold-expiry-${label}`;
  store.database
    .prepare(
      `INSERT INTO ingest
       (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES (?, ?, 'gmail.message.received', 1, ?, ?, ?, ?, ?)`,
    )
    .run(eventId, store.installationId, ACCOUNT, label, STAGED_AT, STAGED_AT, STAGED_AT);
  store.database
    .prepare(
      `INSERT INTO ingest_rules
       (event_id, rule_id, rule_version, decision_deadline, encrypted_projection)
       VALUES (?, 'rule-e8-race', 1, ?, X'01')`,
    )
    .run(eventId, STAGED_AT + 60_000);
  store.database
    .prepare(
      `INSERT INTO decisions
       (id, event_id, account_id, rule_id, rule_version, outcome, hold_created_at, hold_expires_at, hold_bound_by,
        metadata_expires_at, metadata_state, encrypted_record)
       VALUES (?, ?, ?, 'rule-e8-race', 1, 'hold', ?, ?, 'hold-window', ?, 'retained', X'02')`,
    )
    .run(decisionId, eventId, ACCOUNT, STAGED_AT, STAGED_AT + 60_000, STAGED_AT + 60_000);
  return { stateDir, store, eventId, decisionId };
}

test('E12 hold claim expiry caller terminalises through its exact production operation', {
  skip: WINDOWS_SKIP,
}, async () => {
  const resourcesBefore = lastingResources();
  const setup = await holdExpiryFixture('claim');
  try {
    setup.store.database.prepare('UPDATE decisions SET hold_expires_at = 0 WHERE id = ?').run(setup.decisionId);
    assert.deepEqual(
      claimHeldDecision({ store: setup.store, decisionId: setup.decisionId, leaseMs: 30_000 }),
      { kind: 'expired' },
      'claiming an expired hold runs the claim-path expiry call',
    );
    assertExpiredHeldDecision(setup, 'claim path');
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    lastingResources(),
    resourcesBefore,
    'the exact hold-claim expiry path closes every database and asynchronous handle',
  );
});

test('E12 hold expiry API caller terminalises through its exact production operation', {
  skip: WINDOWS_SKIP,
}, async () => {
  const resourcesBefore = lastingResources();
  const setup = await holdExpiryFixture('api');
  try {
    setup.store.database.prepare('UPDATE decisions SET hold_expires_at = 0 WHERE id = ?').run(setup.decisionId);
    assert.equal(expireHeldDecisions(setup.store), 1, 'the public expiry API terminalises one expired hold');
    assertExpiredHeldDecision(setup, 'public API');
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    lastingResources(),
    resourcesBefore,
    'the public hold-expiry API path closes every database and asynchronous handle',
  );
});

test('E12 final hold-resolution expiry caller commits terminal purge before reporting stale', {
  skip: WINDOWS_SKIP,
}, async () => {
  const resourcesBefore = lastingResources();
  const setup = await holdExpiryFixture('resolution');
  try {
    const claimed = claimHeldDecision({
      store: setup.store,
      decisionId: setup.decisionId,
      leaseMs: 30_000,
    });
    assert.equal(claimed.kind, 'claimed', 'the final-resolution fixture owns the live hold claim');
    if (claimed.kind !== 'claimed') throw new Error('the final-resolution fixture must own one claim');
    setup.store.database.prepare('UPDATE decisions SET hold_expires_at = 0 WHERE id = ?').run(setup.decisionId);
    assert.throws(
      () =>
        commitHeldDecisionOutbox(setup.store, {
          id: setup.decisionId,
          eventId: setup.eventId,
          accountId: ACCOUNT,
          ruleId: 'rule-e8-race',
          ruleVersion: 1,
          claimToken: claimed.claim.claimToken,
          outcome: 'no-match',
          switchGeneration: 8,
          deliveries: [],
          disclosure: { approvalId: 'approval-e8', authorizationActivationId: 'activation-e8' },
        }),
      StaleDecisionError,
      'the final-resolution transaction expires the hold before accepting its result',
    );
    assertExpiredHeldDecision(setup, 'final resolution');
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    lastingResources(),
    resourcesBefore,
    'the final hold-resolution expiry path closes every database and asynchronous handle',
  );
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

function pausedSecondAuthorisation(): {
  readonly authorise: () => Promise<void>;
  readonly paused: Promise<void>;
  readonly resume: () => void;
} {
  let checks = 0;
  let signalPaused: (() => void) | undefined;
  let resume: (() => void) | undefined;
  const paused = new Promise<void>((resolve) => {
    signalPaused = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  return {
    authorise: async () => {
      checks += 1;
      if (checks !== 2) return;
      signalPaused?.();
      await resumed;
    },
    paused,
    resume: () => resume?.(),
  };
}

async function expectPausedPurgeRace(
  label: string,
  mutate: (setup: Awaited<ReturnType<typeof fixture>>) => Promise<void> | void,
  options: Readonly<{
    fixture?: Parameters<typeof fixture>[0];
    resolver?: (setup: Awaited<ReturnType<typeof fixture>>) => Parameters<typeof resolverFor>[3];
  }> = {},
): Promise<void> {
  const setup = await fixture(options.fixture);
  const seam = pausedSecondAuthorisation();
  try {
    const requestsBefore = setup.transportCalls();
    const resolving = resolverFor(setup, seam.authorise, undefined, options.resolver?.(setup)).resolve({
      decisionId: setup.decisionId,
      decision: 'accept',
    });
    await seam.paused;
    await mutate(setup);
    seam.resume();
    assert.deepEqual(await resolving, { kind: 'stale' }, `${label}: resumed stale work is refused`);
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as { count: number }).count,
      0,
      `${label}: no stale delivery write survives the race`,
    );
    assert.equal(setup.transportCalls(), requestsBefore, `${label}: held resolution emits no new network attempt`);
  } finally {
    seam.resume();
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
}

test('E12 judge race: paused held resolution loses to target, subscriber, judge, account re-add, WhatsApp hide and expiry purges', {
  skip: WINDOWS_SKIP,
}, async () => {
  const resourcesBefore = lastingResources();
  await expectPausedPurgeRace('target remove', async (setup) => {
    await removeTarget(setup.store, { cancelForRevocation: async () => undefined }, target.targetId);
  });
  await expectPausedPurgeRace('judge remove', async (setup) => {
    const control = new B3OperatorControl({
      store: setup.store,
      ports: { quiescer: testWriterQuiescer() } as never,
      activations: { cancelForRevocation: async () => undefined } as never,
      now: () => STAGED_AT + 1,
    });
    await control.handle({ operation: 'removeJudge', args: { judgeId: judge.judgeId } });
  });
  await expectPausedPurgeRace('subscriber remove', async (setup) => {
    const subscriber = {
      subscriberId: 'subscriber-e12-race',
      version: 1,
      kind: 'sse' as const,
      authority: { host: '127.0.0.1' as const, port: 43_102 },
      origins: ['https://console.invalid'],
      retentionMs: 60_000,
    };
    new ImmutableVersions(setup.store.database).createSubscriber(subscriber);
    const row = setup.store.database
      .prepare('SELECT document FROM rule_versions WHERE rule_id = ? AND version = 1')
      .get('rule-e8-race') as { document: string };
    const document = JSON.parse(row.document) as Record<string, unknown>;
    document.subscribers = [subscriber];
    setup.store.database
      .prepare('UPDATE rule_versions SET document = ? WHERE rule_id = ? AND version = 1')
      .run(canonicalJson(document), 'rule-e8-race');
    const control = new B3OperatorControl({
      store: setup.store,
      ports: { quiescer: testWriterQuiescer(), closeSubscriberStreams: () => undefined } as never,
      now: () => STAGED_AT + 1,
    });
    await control.handle({ operation: 'removeSubscriber', args: { subscriberId: subscriber.subscriberId } });
  });
  let accountPresent = true;
  const config = {
    load: async () => ({
      inboxes: accountPresent ? { synthetic: { id: ACCOUNT, provider: 'gmail' } } : {},
      accounts: {},
    }),
  };
  await expectPausedPurgeRace(
    'account remove and re-add',
    (setup) => {
      accountPresent = false;
      purgeRemovedAccountWork(setup.store.database, { source: 'gmail', accountId: ACCOUNT }, STAGED_AT + 1);
      accountPresent = true;
      assert.equal(
        (
          setup.store.database
            .prepare('SELECT COUNT(*) AS count FROM account_revocations WHERE account_id = ?')
            .get(ACCOUNT) as { count: number }
        ).count,
        1,
        'account re-add cannot erase the stale identity revocation marker',
      );
    },
    {
      resolver: () => ({
        accountLive: ({ source, accountId }) => assertLiveEventAccount(config as never, { source, accountId }),
      }),
    },
  );
  let whatsappVisible = true;
  const whatsappVisibility = (setup: Awaited<ReturnType<typeof fixture>>) =>
    new WhatsAppVisibilityFence({
      store: setup.store,
      now: () => STAGED_AT + 1,
      withCurrentEventVisibility: async (_input, work) =>
        work({
          version: 1,
          digest: (whatsappVisible ? 'a' : 'b').repeat(64),
          seesMessage: () => whatsappVisible,
        }),
    });
  await expectPausedPurgeRace(
    'WhatsApp hide',
    async (setup) => {
      whatsappVisible = false;
      await whatsappVisibility(setup).withCurrentVisibility({ accountId: setup.accountId }, () => undefined);
    },
    {
      fixture: { source: 'whatsapp' },
      resolver: (setup) => ({ whatsappVisibilityFence: whatsappVisibility(setup) }),
    },
  );
  await expectPausedPurgeRace('expiry', (setup) => {
    setup.store.database.prepare('UPDATE decisions SET hold_expires_at = 0 WHERE id = ?').run(setup.decisionId);
    new EventExpiry(setup.store, () => STAGED_AT + 1).sweep();
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    lastingResources(),
    resourcesBefore,
    'paused purge races close every socket, database and asynchronous handle on every path',
  );
});
