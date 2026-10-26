import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CommsError, canonicalJson, type DesktopOrigin, sha256Hex } from '@agentcomms/core';
import { type EventsCliStreams, run } from '../src/cli/program.ts';
import type { AnalyseProvider } from '../src/domain/analyse-model.ts';
import type { EventSecretProvider } from '../src/domain/providers.ts';
import type { RuleAnalyseResultV1 } from '../src/domain/rule-analyse.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { RuleAnalyseService } from '../src/runtime/rule-analyse.ts';
import { type EventDatabase, openEventDatabase } from '../src/store/database.ts';
import { selectEventSecretStore } from '../src/store/event-secrets.ts';
import { emptyConfigDir } from './support/config-dir.ts';
import {
  anthropicAnswer,
  chunkedResponse,
  type FakeModelProvider,
  httpResponse,
  openRouterAnswer,
  startFakeModelProvider,
  suggestion,
} from './support/fake-model-provider.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/*
 * `rule analyse` in the event service (0.33.0 design §3.3), against a seeded database and a loopback fake of OpenRouter
 * and Anthropic: no real provider is called and every key is fake. It reads the rule and content-free counts; what
 * the model is sent is the rule's own text and those counts, and nothing a sender wrote; it never applies anything.
 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const ACCOUNT = 'ibx_ANALYSESEEDED001';
const RULE = 'invoices';
const QUESTION = 'Is this asking me to pay or send something?';

// Sender material the seeded database holds where a message's content lives. None of it may reach a model request.
const SENTINELS = {
  subject: 'SENTINEL-SUBJECT-Overdue-invoice-4471',
  body: 'SENTINEL-BODY-wire-the-money-today',
  snippet: 'SENTINEL-SNIPPET-please-pay',
  address: 'sentinel.sender@leaky-domain.example',
  name: 'SENTINEL Sender Name',
  domain: 'leaky-domain.example',
} as const;

const PLAIN = { decrypt: async (_location: unknown, bytes: Uint8Array) => Buffer.from(bytes) };

function ruleDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ruleId: RULE,
    version: 1,
    source: {
      channel: 'gmail',
      accountIds: [ACCOUNT],
      options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'contains', value: 'invoice', caseSensitive: false },
    agentic: {
      judge: { judgeId: 'jev', version: 1 },
      question: QUESTION,
      inputs: ['/subject'],
      threshold: 0.7,
      onUncertain: 'no-match',
      callsPerRollingHour: 60,
      inputTokensPerRolling30Days: 1_000_000,
      concurrency: 1,
      maxInputTokens: 2000,
      maxOutputTokens: 16,
    },
    mapping: { from: { $path: '/from' }, subject: { $path: '/subject' } },
    targets: [
      { targetId: 'billing', version: 1, kind: 'queue', retentionMs: 7 * DAY, show: 'summary' },
      {
        targetId: 'billing-session',
        version: 1,
        kind: 'session',
        context: [{ text: 'Check the invoice against Stripe before replying.' }],
      },
      { targetId: 'billing-issue', version: 1, kind: 'linear', title: 'Invoice from {{from.name}}' },
    ],
    subscribers: [],
    judges: [],
    deliveryRateCap: 60,
    retention: { decisionMetadataMs: 90 * DAY, queueMs: 7 * DAY },
    ...overrides,
  };
}

let sequence = 0;

/** One observed message and the rule's decision on it, with its judge metadata, as the owner keeps them. */
function seedDecision(
  store: EventDatabase,
  input: {
    readonly observedAt?: number;
    readonly outcome?: string;
    readonly value?: number;
    readonly senderDomain?: string;
    readonly item?: 'open' | 'done' | 'dismissed';
  },
): void {
  sequence += 1;
  const eventId = sequence.toString(16).padStart(32, '0');
  const observedAt = input.observedAt ?? NOW - DAY;
  const database = store.database;
  database
    .prepare(
      `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES (?, ?, 'gmail.message.received', 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventId,
      store.installationId,
      ACCOUNT,
      canonicalJson([String(1000 + sequence), `msg-${sequence}`, 'received']),
      observedAt,
      observedAt,
      observedAt,
    );
  // A projection still held for the message: the event as the rule sees it, sender material and all.
  database
    .prepare(
      'INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection) VALUES (?, ?, 1, ?, ?)',
    )
    .run(
      eventId,
      `${RULE}-other`,
      NOW + DAY,
      Buffer.from(
        JSON.stringify({
          event: {
            subject: SENTINELS.subject,
            snippet: SENTINELS.snippet,
            body: SENTINELS.body,
            from: { address: SENTINELS.address, name: SENTINELS.name },
          },
        }),
      ),
    );
  const decisionId = `decision-analyse-${sequence}`;
  const metadata =
    input.value === undefined
      ? null
      : {
          judgeId: 'jev',
          judgeVersion: 1,
          provider: 'openrouter',
          model: 'typesafe/jev-1.14',
          promptTemplate: 'typesafe-jev-noul-v1',
          threshold: 0.7,
          value: input.value,
          valueLabel: 'probability',
          ...(input.senderDomain === undefined ? {} : { senderDomain: input.senderDomain }),
        };
  database
    .prepare(
      `INSERT INTO decisions
         (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state, encrypted_record)
       VALUES (?, ?, ?, ?, 1, ?, ?, 'retained', ?)`,
    )
    .run(
      decisionId,
      eventId,
      ACCOUNT,
      RULE,
      input.outcome ?? (input.value !== undefined && input.value >= 0.7 ? 'matched' : 'no-match'),
      NOW + 90 * DAY,
      metadata === null ? null : Buffer.from(JSON.stringify(metadata)),
    );
  if (input.item === undefined) return;
  const deliveryId = `delivery-analyse-${sequence}`;
  database
    .prepare(
      `INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
          encrypted_record, expires_at, state, switch_generation)
       VALUES (?, ?, ?, ?, 1, 'queue:billing:1', 'billing', 1, 'queue', NULL, ?, 'delivered', 1)`,
    )
    .run(deliveryId, decisionId, ACCOUNT, RULE, NOW + 7 * DAY);
  database
    .prepare(
      `INSERT INTO queue_items
         (id, delivery_id, decision_id, event_id, rule_id, rule_version, target_id, target_version, account_id,
          channel, state, state_at, arrived_at, appended_at, retention_ms, expires_at, row_expires_at, released,
          encrypted_record)
       VALUES (?, ?, ?, ?, ?, 1, 'billing', 1, ?, 'gmail', ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      `qi_${String(sequence).padStart(26, '0')}`,
      deliveryId,
      decisionId,
      eventId,
      RULE,
      ACCOUNT,
      input.item,
      observedAt + 2_000,
      observedAt + 1_000,
      observedAt + 1_000,
      7 * DAY,
      observedAt + 7 * DAY,
      observedAt + 14 * DAY,
      // The item's kept content: the sender, the subject and the snippet, as a `show: summary` queue keeps them.
      Buffer.from(
        JSON.stringify({
          from: { address: SENTINELS.address, name: SENTINELS.name },
          subject: SENTINELS.subject,
          snippet: SENTINELS.snippet,
        }),
      ),
    );
}

function storeRule(store: EventDatabase, document: Record<string, unknown>, state = 'active'): void {
  const text = canonicalJson(document as never);
  store.database
    .prepare(
      `INSERT INTO rule_versions
         (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'approval', 'activation', 1)`,
    )
    .run(
      `${String(document.ruleId)}@${String(document.version)}`,
      String(document.ruleId),
      Number(document.version),
      text,
      sha256Hex(text),
      state,
    );
}

/** The seeded month: three domains the judge refused, one it passed, kept and dismissed scores that separate. */
function seedMonth(store: EventDatabase): void {
  for (const value of [0.1, 0.2, 0.05]) seedDecision(store, { value, senderDomain: 'receipts.shop.example' });
  for (const value of [0.3, 0.12, 0.2, 0.4]) seedDecision(store, { value, senderDomain: SENTINELS.domain });
  seedDecision(store, { value: 0.91, senderDomain: 'supplier.example', item: 'done' });
  seedDecision(store, { value: 0.86, senderDomain: 'supplier.example', item: 'done' });
  seedDecision(store, { value: 0.73, item: 'dismissed', outcome: 'matched' });
  seedDecision(store, { value: 0.71, item: 'dismissed', outcome: 'matched' });
  seedDecision(store, { value: 0.95, item: 'open' });
  // Older than 30 days: not counted.
  seedDecision(store, { value: 0.99, senderDomain: 'receipts.shop.example', observedAt: NOW - 40 * DAY });
  // A decision the condition refused, with no judge.
  seedDecision(store, { outcome: 'no-match' });
}

async function withStore(work: (store: EventDatabase) => Promise<void>): Promise<void> {
  const stateDir = await shortTempDir('aev-analyse-');
  const store = await openEventDatabase({ stateDir });
  try {
    storeRule(store, ruleDocument());
    seedMonth(store);
    await work(store);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

const KEYS: Record<AnalyseProvider, string> = { openrouter: 'fake-or-analyse', anthropic: 'fake-an-analyse' };

function service(
  store: EventDatabase,
  options: { readonly keys?: readonly AnalyseProvider[]; readonly fake?: FakeModelProvider } = {},
): RuleAnalyseService {
  const keys = new Set<EventSecretProvider>(options.keys ?? []);
  return new RuleAnalyseService({
    store,
    cipher: PLAIN,
    keyPresence: () =>
      (['typesafe', 'openrouter', 'anthropic'] as const).map((provider) => ({ provider, hasKey: keys.has(provider) })),
    keyFor: async (provider) => (keys.has(provider) ? KEYS[provider] : null),
    transport: options.fake?.transport() ?? {
      call: async () => assert.fail('no model call is made without a key'),
    },
    now: () => NOW,
  });
}

test('ANALYSE-E: the counts and the suggestions made without a model, from a seeded month', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  await withStore(async (store) => {
    const result = await service(store).analyse({ ruleId: RULE });
    t.diagnostic(`rule analyse (no key): ${JSON.stringify(result)}`);
    assert.deepEqual(result.analysed, { source: 'stored', version: 1 });
    assert.equal(result.counts.decisions, 13, 'the decision 40 days back is not counted');
    assert.deepEqual(result.counts.outcomes, {
      matched: 5,
      'no-match': 8,
      'mapping-rejected': 0,
      'retention-expired': 0,
      hold: 0,
    });
    assert.deepEqual(
      { ...result.counts.judge, spread: undefined },
      { answered: 12, yes: 5, no: 7, held: 0, spread: undefined, lowest: 0.05, highest: 0.95 },
    );
    assert.equal(result.counts.domainsKnown, 9);
    assert.deepEqual(
      result.counts.domains.map((entry) => ({ ...entry, domain: entry.domain.split('\n')[1] })),
      [
        { domain: SENTINELS.domain, judged: 4, yes: 0, no: 4 },
        { domain: 'receipts.shop.example', judged: 3, yes: 0, no: 3 },
        { domain: 'supplier.example', judged: 2, yes: 2, no: 0 },
      ],
    );
    for (const entry of result.counts.domains)
      assert.match(
        entry.domain,
        /^<untrusted-content boundary="[^"]+" field="senderDomain">\n[a-z.-]+\n<\/untrusted-content/u,
      );
    assert.deepEqual(result.counts.queue, {
      open: 1,
      done: 2,
      dismissed: 2,
      lowestDone: 0.86,
      highestDismissed: 0.73,
    });
    assert.deepEqual(
      result.suggestions.map((entry) => [entry.part, entry.after]),
      [
        [
          'condition',
          `match all\n  subject contains "invoice"\n  not from.address has domain "${SENTINELS.domain}"\n  not from.address has domain "receipts.shop.example"`,
        ],
        ['judge.threshold', 'yes at 0.79, if unsure drop'],
      ],
    );
    assert.deepEqual(result.model, {
      provider: null,
      name: null,
      model: null,
      ran: false,
      reason: 'NO_KEY',
      noKey: ['openrouter', 'anthropic'],
      sent: "The rule's own text and content-free counts of its last 30 days: never a message, a sender, a subject, a body or an address.",
      parts: [
        { part: 'judge.question', at: {}, outcome: 'not-run' },
        { part: 'session.context', at: { targetId: 'billing-session', contextIndex: 0 }, outcome: 'not-run' },
        { part: 'linear.title', at: { targetId: 'billing-issue' }, outcome: 'not-run' },
      ],
    });
    const text = JSON.stringify(result);
    for (const value of [SENTINELS.subject, SENTINELS.body, SENTINELS.snippet, SENTINELS.address, SENTINELS.name])
      assert.equal(text.includes(value), false, `the result holds no ${value}`);
  });
});

test('ANALYSE-E: a model is sent the rule’s own text and the counts, and no message content — no subject, body, address or domain', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const fake = await startFakeModelProvider();
  try {
    await withStore(async (store) => {
      fake.respond((request) => {
        const user = JSON.parse(
          ((request.body.messages as { role: string; content: string }[])[1] as { content: string }).content,
        ) as { part: string };
        const after = {
          'judge.question': 'Is the sender asking me to pay them, or to send them an invoice?',
          'session.context':
            'Task: answer an invoice request.\n1. Find the invoice in Stripe.\n2. Draft a reply and wait for my approval.\nNever pay. If unsure, ask me.',
          'linear.title': 'Invoice request from {{from.name}}',
        }[user.part];
        return httpResponse(200, openRouterAnswer(suggestion(after ?? 'x')));
      });
      const result = await service(store, { keys: ['openrouter'], fake }).analyse({ ruleId: RULE });
      t.diagnostic(`rule analyse (OpenRouter): ${JSON.stringify(result)}`);
      assert.equal(fake.requests.length, 3, 'one call per part, each with its own brief');
      assert.deepEqual(fake.resolved, ['openrouter.ai', 'openrouter.ai', 'openrouter.ai']);
      assert.deepEqual(
        {
          provider: result.model.provider,
          name: result.model.name,
          model: result.model.model,
          ran: result.model.ran,
        },
        { provider: 'openrouter', name: 'OpenRouter', model: 'anthropic/claude-sonnet-5.5', ran: true },
        'the result names the provider and model used',
      );
      assert.deepEqual(
        result.suggestions.filter((entry) => entry.evidence.by === 'model').map((entry) => [entry.part, entry.before]),
        [
          ['judge.question', QUESTION],
          ['session.context', 'Check the invoice against Stripe before replying.'],
          ['linear.title', 'Invoice from {{from.name}}'],
        ],
      );
      for (const request of fake.requests) {
        assert.equal(request.requestLine, 'POST /api/v1/chat/completions HTTP/1.1');
        assert.equal(request.headers.get('host'), 'openrouter.ai');
        assert.equal(request.headers.get('authorization'), `Bearer ${KEYS.openrouter}`);
        assert.equal(
          request.raw.split(KEYS.openrouter).length - 1,
          1,
          'the key is in its one header, and nowhere else',
        );
        // The guarantee: nothing a sender wrote, and no full address or sending domain, is in any byte sent.
        for (const [what, value] of Object.entries(SENTINELS))
          assert.equal(request.raw.includes(value), false, `a model request holds the message's ${what}`);
        for (const value of ['receipts.shop.example', 'supplier.example', 'untrusted-content', ACCOUNT])
          assert.equal(request.raw.includes(value), false, `a model request holds ${value}`);
        const user = JSON.parse(
          ((request.body.messages as { content: string }[])[1] as { content: string }).content,
        ) as Record<string, unknown>;
        assert.deepEqual(Object.keys(user), ['part', 'rule', 'now', 'counts']);
        assert.equal((user.counts as { decisions: number }).decisions, 13, 'the counts are sent');
      }
      assert.match(
        fake.requests[0]?.raw ?? '',
        /Is this asking me to pay or send something\?/u,
        'the rule’s own text is',
      );
    });
  } finally {
    await fake.close();
  }
});

test('ANALYSE-E: on Anthropic, the Messages API with its version and key headers, read from a chunked reply', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fake = await startFakeModelProvider();
  try {
    await withStore(async (store) => {
      fake.respond(() => chunkedResponse(200, anthropicAnswer(suggestion('Is the sender asking me to pay them?'))));
      const result = await service(store, { keys: ['openrouter', 'anthropic'], fake }).analyse({
        ruleId: RULE,
        provider: 'anthropic',
        draft: ruleDocument({ targets: [{ targetId: 'billing', version: 1, kind: 'queue', retentionMs: 7 * DAY }] }),
      });
      assert.deepEqual(result.analysed, { source: 'draft' });
      assert.equal(result.model.provider, 'anthropic');
      assert.equal(result.model.model, 'claude-sonnet-5-5');
      assert.equal(fake.requests.length, 1, 'the draft has one part for a model: its question');
      const [request] = fake.requests;
      assert.equal(request?.requestLine, 'POST /v1/messages HTTP/1.1');
      assert.equal(request?.headers.get('host'), 'api.anthropic.com');
      assert.equal(request?.headers.get('x-api-key'), KEYS.anthropic);
      assert.equal(request?.headers.get('anthropic-version'), '2026-10-21');
      assert.equal(request?.headers.has('authorization'), false);
      assert.deepEqual(fake.resolved, ['api.anthropic.com']);
      const question = result.suggestions.find((entry) => entry.part === 'judge.question');
      assert.deepEqual(question?.evidence, { by: 'model', provider: 'anthropic', model: 'claude-sonnet-5-5' });
      assert.equal(question?.after, 'Is the sender asking me to pay them?');
    });
  } finally {
    await fake.close();
  }
});

test('ANALYSE-E: malformed or refused model output is refused, each part with its closed reason, and nothing is suggested', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fake = await startFakeModelProvider();
  try {
    await withStore(async (store) => {
      const replies = [
        httpResponse(200, openRouterAnswer('Here is a better question: Is the sender asking me to pay?')),
        httpResponse(200, openRouterAnswer(JSON.stringify({ after: 'x', why: 'y', extra: true }))),
        httpResponse(200, openRouterAnswer(suggestion('Invoice from {{password}}'))),
      ];
      const reasons = ['MODEL_OUTPUT_NOT_JSON', 'MODEL_OUTPUT_SHAPE', 'MODEL_OUTPUT_SLOTS'];
      fake.respond((request) => {
        const part = (
          JSON.parse(((request.body.messages as { content: string }[])[1] as { content: string }).content) as {
            part: string;
          }
        ).part;
        return replies[['judge.question', 'session.context', 'linear.title'].indexOf(part)] as string;
      });
      const result = await service(store, { keys: ['openrouter'], fake }).analyse({ ruleId: RULE });
      assert.deepEqual(
        result.model.parts.map((part) => part.outcome),
        reasons,
      );
      assert.equal(result.model.ran, true);
      assert.equal(
        result.suggestions.some((entry) => entry.evidence.by === 'model'),
        false,
        'a refused answer suggests nothing',
      );
      for (const [reply, reason] of [
        [httpResponse(401, '{"error":{"message":"SENTINEL provider text"}}'), 'MODEL_KEY_REFUSED'],
        [httpResponse(429, '{}'), 'MODEL_RATE_LIMITED'],
        [httpResponse(529, '{}'), 'MODEL_UNAVAILABLE'],
        [httpResponse(200, openRouterAnswer(suggestion('Fine?'), 'length')), 'MODEL_OUTPUT_TRUNCATED'],
        [httpResponse(200, '{"choices": "nope"}'), 'RESPONSE_MALFORMED'],
        ['HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n{}', 'RESPONSE_MALFORMED'],
        [httpResponse(200, 'x'.repeat(300_000)), 'RESPONSE_TOO_LARGE'],
      ] as const) {
        fake.respond(() => reply);
        const refused = await service(store, { keys: ['openrouter'], fake }).analyse({
          ruleId: RULE,
          draft: ruleDocument({ targets: [{ targetId: 'billing', version: 1, kind: 'queue', retentionMs: 7 * DAY }] }),
        });
        assert.deepEqual(refused.model.parts, [{ part: 'judge.question', at: {}, outcome: reason }], reason);
        assert.equal(JSON.stringify(refused).includes('SENTINEL provider text'), false, 'no provider text is kept');
      }
    });
  } finally {
    await fake.close();
  }
});

test('ANALYSE-E: with no key the result says which provider has none, and no call is made', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withStore(async (store) => {
    const named = await service(store, { keys: ['openrouter'] }).analyse({ ruleId: RULE, provider: 'anthropic' });
    assert.deepEqual(
      { ...named.model, parts: named.model.parts.length },
      {
        provider: 'anthropic',
        name: 'Anthropic',
        model: 'claude-sonnet-5-5',
        ran: false,
        reason: 'NO_KEY',
        noKey: ['anthropic'],
        sent: named.model.sent,
        parts: 3,
      },
    );
    assert.equal(named.suggestions.length, 2, 'the suggestions from the counts still come');
    const none = await service(store).analyse({ ruleId: RULE });
    assert.deepEqual(
      [none.model.provider, none.model.reason, none.model.noKey],
      [null, 'NO_KEY', ['openrouter', 'anthropic']],
    );
    const nothing = await service(store).analyse({
      ruleId: RULE,
      draft: ruleDocument({ agentic: undefined, targets: [] }),
    });
    assert.deepEqual([nothing.model.ran, nothing.model.reason, nothing.model.parts], [false, 'NO_MODEL_PARTS', []]);
  });
});

test('ANALYSE-E: its arguments are read strictly; an unknown rule without a draft is not found; a new rule’s draft has no history', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withStore(async (store) => {
    const analyse = (args: Record<string, unknown>) => service(store).analyse(args);
    for (const args of [
      {},
      { ruleId: '' },
      { ruleId: 'has space' },
      { ruleId: RULE, provider: 'typesafe' },
      { ruleId: RULE, draft: [] },
      { ruleId: RULE, draft: ruleDocument({ ruleId: 'another-rule' }) },
      { ruleId: RULE, draft: { big: 'x'.repeat(60_000) } },
      { ruleId: RULE, caller: { sessionId: 'x' } },
    ])
      await assert.rejects(
        () => analyse(args),
        (error: unknown) => error instanceof CommsError && error.code === 'USAGE',
        JSON.stringify(args).slice(0, 80),
      );
    await assert.rejects(
      () => analyse({ ruleId: 'never-made' }),
      (error: unknown) => error instanceof CommsError && error.code === 'NOT_FOUND',
    );
    const fresh = await analyse({
      ruleId: 'never-made',
      draft: ruleDocument({ ruleId: 'never-made', agentic: undefined }),
    });
    assert.deepEqual(fresh.analysed, { source: 'draft' });
    assert.equal(fresh.counts.decisions, 0);
    assert.match(fresh.suggestions[0]?.why ?? '', /no history on this Mac yet/u);
    // Analyse writes nothing.
    const before = store.database.prepare('SELECT COUNT(*) AS count FROM rule_versions').get();
    await analyse({ ruleId: RULE });
    assert.deepEqual(store.database.prepare('SELECT COUNT(*) AS count FROM rule_versions').get(), before);
  });
});

/** The release app, attested as the process that started the CLI (core's `desktopAppOrigin`, injected here). */
const ATTESTED = async (): Promise<DesktopOrigin> => ({
  ok: true,
  build: 'release',
  identifier: 'com.cueplusplus.agentcomms',
});

async function cli(
  args: readonly string[],
  options: { readonly stdin?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const stdin = new PassThrough();
  stdin.end(options.stdin ?? '');
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  stderr.on('data', (chunk) => {
    err += String(chunk);
  });
  const streams: EventsCliStreams = { stdin, stdout, stderr };
  const code = await run(args, { streams, env: options.env ?? {}, desktopOrigin: ATTESTED });
  return { code, stdout: out, stderr: err };
}

test('ANALYSE-CLI: rule analyse refuses inside the event service’s MCP server (10), and bad arguments are 64, before any owner', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-analyse-cli-');
  try {
    const refused = await cli(['--state-dir', stateDir, 'rule', 'analyse', RULE, '--json'], {
      env: { AGENTCOMMS_MCP_SERVER: 'events' },
    });
    assert.equal(refused.code, 10, refused.stderr);
    assert.match(refused.stderr, /analysing a rule is for a person, at a terminal or in the app/u);
    for (const [args, stdin] of [
      [['rule', 'analyse', RULE, '--provider', 'typesafe'], ''],
      [['rule', 'analyse', RULE, '--draft', 'draft.json'], ''],
      [['rule', 'analyse', RULE, '--draft', '-'], 'when a new message arrives'],
      [['rule', 'analyse', RULE, '--draft', '-'], '[1, 2]'],
      [['rule', 'analyse', 'not a rule id'], ''],
    ] as const) {
      const bad = await cli(['--state-dir', stateDir, ...args, '--json'], { stdin });
      assert.equal(bad.code, 64, `${args.join(' ')}: ${bad.stderr}`);
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('ANALYSE-OWNER: through a real owner, a draft on stdin is analysed on the person’s OpenRouter key, and the result names it', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const stateDir = await shortTempDir('aev-analyse-owner-');
  const fake = await startFakeModelProvider();
  const configDir = await emptyConfigDir(stateDir);
  const opened = await openEventDatabase({ stateDir });
  await selectEventSecretStore(opened.database, 'file');
  opened.close();
  const owner = await startEventOwner({ stateDir, configDir, tickMs: 60_000, analyseTransport: fake.transport() });
  try {
    fake.respond(() => httpResponse(200, openRouterAnswer(suggestion('Is the sender asking me to pay them?'))));
    const key = await cli(['--state-dir', stateDir, '--json', 'provider', 'key', 'set', 'openrouter'], {
      stdin: `${KEYS.openrouter}\n`,
    });
    assert.equal(key.code, 0, key.stderr);
    const draft = ruleDocument({
      ruleId: 'new-invoices',
      targets: [{ targetId: 'billing', version: 1, kind: 'queue', retentionMs: 7 * DAY }],
    });
    const analysed = await cli(['--state-dir', stateDir, '--json', 'rule', 'analyse', 'new-invoices', '--draft', '-'], {
      stdin: JSON.stringify(draft),
    });
    assert.equal(analysed.code, 0, analysed.stderr);
    t.diagnostic(`rule analyse --draft - --json: ${analysed.stdout.trim()}`);
    const result = JSON.parse(analysed.stdout) as RuleAnalyseResultV1;
    assert.deepEqual(result.analysed, { source: 'draft' });
    assert.deepEqual(
      [result.model.provider, result.model.model, result.model.ran],
      ['openrouter', 'anthropic/claude-sonnet-5.5', true],
    );
    assert.deepEqual(
      result.suggestions.map((entry) => entry.part),
      ['general', 'judge.question'],
    );
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0]?.headers.get('authorization'), `Bearer ${KEYS.openrouter}`);
    assert.equal(analysed.stdout.includes(KEYS.openrouter), false, 'the key is never printed');
    const unknown = await cli(['--state-dir', stateDir, '--json', 'rule', 'analyse', 'no-such-rule']);
    assert.equal(unknown.code, 66, unknown.stderr);
  } finally {
    await owner.stop();
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
