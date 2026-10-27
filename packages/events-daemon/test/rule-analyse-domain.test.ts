import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ANALYSE_ROUTES,
  buildAnalyseRequest,
  chooseAnalyseProvider,
  readAnalyseResponse,
  refusalForStatus,
} from '../src/domain/analyse-model.ts';
import { ANALYSE_PROMPTS } from '../src/domain/analyse-prompts.ts';
import {
  ANALYSE_SENT,
  deterministicSuggestions,
  type JudgedFact,
  mappedFieldNames,
  modelCounts,
  modelInput,
  modelPartsOf,
  type QueueFact,
  type RuleAnalyseFacts,
  readModelAnswer,
  redactConditionLiterals,
  summariseAnalyseFacts,
} from '../src/domain/rule-analyse.ts';
import { readHttpResponse } from '../src/runtime/analyse-transport.ts';

/*
 * Analyse's pure half (0.33.0 design §3.3): the counts, the three suggestions made with no model, the parts a model may
 * improve, what a model is sent, and the strict reading of what it answers.
 */

const DAY = 86_400_000;
const wrap = (domain: string) =>
  `<untrusted-content boundary="B" field="senderDomain">\n${domain}\n</untrusted-content>`;

function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ruleId: 'invoices',
    version: 2,
    source: {
      channel: 'gmail',
      accountIds: ['ibx_ANALYSEDOMAIN001'],
      options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: {
      any: [
        { path: '/subject', op: 'contains', value: 'invoice', caseSensitive: false },
        { path: '/subject', op: 'contains', value: 'payment', caseSensitive: false },
      ],
    },
    agentic: {
      judge: { judgeId: 'jev', version: 1 },
      question: 'Is this asking me to pay or send something?',
      inputs: ['/from/address', '/subject'],
      threshold: 0.7,
      onUncertain: 'no-match',
      callsPerRollingHour: 60,
      inputTokensPerRolling30Days: 1_000_000,
      concurrency: 1,
      maxInputTokens: 2000,
      maxOutputTokens: 16,
    },
    mapping: { from: { $path: '/from' }, subject: { $path: '/subject' } },
    targets: [{ targetId: 'log', version: 1, kind: 'dry-run', retentionMs: DAY }],
    subscribers: [],
    judges: [],
    deliveryRateCap: 60,
    retention: {
      ingestMs: 7 * DAY,
      holdMs: 7 * DAY,
      deliveryMs: 7 * DAY,
      dryrunMs: DAY,
      sseReplayMs: 7 * DAY,
      deadLetterMs: 7 * DAY,
      decisionMetadataMs: 90 * DAY,
    },
    ...overrides,
  };
}

const judged = (value: number, senderDomain: string | null, threshold = 0.7): JudgedFact => ({
  value,
  yes: value >= threshold,
  held: false,
  senderDomain,
});

function facts(overrides: Partial<RuleAnalyseFacts> = {}): RuleAnalyseFacts {
  return {
    since: 1_000,
    decisions: 14,
    outcomes: { matched: 4, 'no-match': 10, 'mapping-rejected': 0, 'retention-expired': 0, hold: 0 },
    judged: [],
    queue: [],
    ...overrides,
  };
}

test('ANALYSE: a domain the judge always said no to, three times or more, becomes an exclusion condition', () => {
  const seeded = facts({
    judged: [
      judged(0.1, 'receipts.shop.example'),
      judged(0.2, 'receipts.shop.example'),
      judged(0.05, 'receipts.shop.example'),
      judged(0.3, 'bank.example'),
      judged(0.1, 'bank.example'),
      judged(0.2, 'bank.example'),
      judged(0.4, 'bank.example'),
      // Twice is not enough, and one yes is enough to keep a domain.
      judged(0.1, 'twice.example'),
      judged(0.1, 'twice.example'),
      judged(0.1, 'mixed.example'),
      judged(0.2, 'mixed.example'),
      judged(0.3, 'mixed.example'),
      judged(0.9, 'mixed.example'),
      judged(0.1, null),
    ],
  });
  const [exclusion] = deterministicSuggestions(rule(), seeded, { hasHistory: true, wrapDomain: wrap });
  assert.equal(exclusion?.part, 'condition');
  assert.equal(
    exclusion?.before,
    ['match any', '  subject contains "invoice"', '  subject contains "payment"'].join('\n'),
  );
  assert.equal(
    exclusion?.after,
    [
      'match all',
      '  any',
      '    subject contains "invoice"',
      '    subject contains "payment"',
      '  not from.address has domain "bank.example"',
      '  not from.address has domain "receipts.shop.example"',
    ].join('\n'),
    'the condition stays, and each domain is left out after it, most refused first',
  );
  assert.match(exclusion?.why ?? '', /said no to all 7 messages from these 2 sending domains/u);
  assert.deepEqual(exclusion?.evidence, {
    by: 'counts',
    windowDays: 30,
    judgedNo: 7,
    domains: [
      { domain: wrap('bank.example'), judgedNo: 4, judgedYes: 0 },
      { domain: wrap('receipts.shop.example'), judgedNo: 3, judgedYes: 0 },
    ],
  });
  // An `all` condition gains the exclusions as members; a rule without a judge or a From address gets none.
  const all = deterministicSuggestions(rule({ condition: { all: [{ path: '/subject', op: 'exists' }] } }), seeded, {
    hasHistory: true,
    wrapDomain: wrap,
  })[0];
  assert.match(all?.after ?? '', /^match all\n {2}subject exists\n {2}not from\.address has domain "bank\.example"/u);
  assert.equal(
    deterministicSuggestions(rule({ agentic: undefined }), seeded, { hasHistory: true, wrapDomain: wrap }).some(
      (entry) => entry.part === 'condition',
    ),
    false,
  );
  assert.equal(
    deterministicSuggestions(rule({ event: { type: 'slack.message.posted', version: 1 } }), seeded, {
      hasHistory: true,
      wrapDomain: wrap,
    }).some((entry) => entry.part === 'condition'),
    false,
  );
  // A condition too long to show twice in one control frame is not rewritten.
  const long = {
    any: Array.from({ length: 200 }, (_, index) => ({
      path: '/subject',
      op: 'contains',
      value: `invoice number ${index} of a very long list`,
      caseSensitive: false,
    })),
  };
  assert.equal(
    deterministicSuggestions(rule({ condition: long }), seeded, { hasHistory: true, wrapDomain: wrap }).some(
      (entry) => entry.part === 'condition',
    ),
    false,
  );
  // A domain that is not a plain hostname is never counted, so never suggested.
  assert.deepEqual(
    deterministicSuggestions(
      rule(),
      facts({
        judged: [judged(0.1, 'evil"\n.example'), judged(0.1, 'evil"\n.example'), judged(0.1, 'evil"\n.example')],
      }),
      { hasHistory: true, wrapDomain: wrap },
    ),
    [],
  );
});

test('ANALYSE: kept against dismissed scores give a judge bar between them, only when they separate', () => {
  const queue = (kept: readonly number[], dismissed: readonly number[]): QueueFact[] => [
    ...kept.map((score) => ({ state: 'done' as const, score })),
    ...dismissed.map((score) => ({ state: 'dismissed' as const, score })),
    { state: 'open', score: 0.99 },
    { state: 'dismissed', score: null },
  ];
  const [bar] = deterministicSuggestions(rule(), facts({ queue: queue([0.86, 0.91, 0.97], [0.71, 0.73]) }), {
    hasHistory: true,
    wrapDomain: wrap,
  });
  assert.deepEqual(bar, {
    part: 'judge.threshold',
    before: 'yes at 0.7, if unsure drop',
    after: 'yes at 0.79, if unsure drop',
    why: 'Every one of the 3 messages you kept scored 0.86 or more, and the 2 you dismissed scored 0.73 at most. A bar of 0.79, between them, keeps the first and leaves out the second.',
    evidence: {
      by: 'counts',
      windowDays: 30,
      kept: 3,
      dismissed: 2,
      lowestKept: 0.86,
      highestDismissed: 0.73,
      threshold: 0.7,
    },
  });
  // Rounded only as far as it stays strictly above every dismissed score and at most the lowest kept one.
  const close = deterministicSuggestions(rule(), facts({ queue: queue([0.7312], [0.7301]) }), {
    hasHistory: true,
    wrapDomain: wrap,
  })[0];
  assert.equal(close?.after, 'yes at 0.731, if unsure drop', 'two places would be 0.73, not above 0.7301');
  for (const [kept, dismissed, why] of [
    [[0.8, 0.9], [0.85], 'they overlap'],
    [[0.8], [0.8], 'they meet'],
    [[0.9], [], 'nothing dismissed'],
    [[], [0.5], 'nothing kept'],
    [[0.9], [0.65], 'the bar of 0.7 already separates them'],
  ] as const)
    assert.equal(
      deterministicSuggestions(rule(), facts({ queue: queue(kept, dismissed) }), {
        hasHistory: true,
        wrapDomain: wrap,
      }).some((entry) => entry.part === 'judge.threshold'),
      false,
      why,
    );
});

test('ANALYSE: a rule with no match in 30 days gets a general note, and none when something passed', () => {
  const none = { matched: 0, 'no-match': 0, 'mapping-rejected': 0, 'retention-expired': 0, hold: 0 };
  const quiet = (input: Partial<RuleAnalyseFacts>, hasHistory = true) =>
    deterministicSuggestions(rule({ agentic: undefined }), facts(input), { hasHistory, wrapDomain: wrap });
  assert.deepEqual(quiet({ decisions: 0, outcomes: none }), [
    {
      part: 'general',
      before: null,
      after: null,
      why: 'No message reached this workflow in the last 30 days. Check that it watches the account and the messages you mean.',
      evidence: { by: 'counts', windowDays: 30, decisions: 0, matched: 0 },
    },
  ]);
  assert.match(quiet({ decisions: 9, outcomes: { ...none, 'no-match': 9 } })[0]?.why ?? '', /9 messages reached it/u);
  assert.match(quiet({ decisions: 0, outcomes: none }, false)[0]?.why ?? '', /no history on this Mac yet/u);
  assert.deepEqual(quiet({ outcomes: { ...none, hold: 1 } }), []);
  assert.deepEqual(quiet({}), []);
});

test('ANALYSE: the counts give the judge’s spread and the queue’s scores, and wrap each listed domain', () => {
  const counts = summariseAnalyseFacts(
    facts({
      judged: [
        judged(0.05, 'a.example'),
        judged(0.75, 'a.example'),
        judged(1, null),
        { ...judged(0.65, null), held: true },
      ],
      queue: [
        { state: 'done', score: 0.9 },
        { state: 'dismissed', score: 0.71 },
        { state: 'open', score: null },
      ],
    }),
    wrap,
  );
  assert.deepEqual(counts.judge, {
    answered: 4,
    yes: 2,
    no: 2,
    held: 1,
    spread: [1, 0, 0, 0, 0, 0, 1, 1, 0, 1],
    lowest: 0.05,
    highest: 1,
  });
  assert.deepEqual(counts.domains, [{ domain: wrap('a.example'), judged: 2, yes: 1, no: 1 }]);
  assert.equal(counts.domainsKnown, 2);
  assert.deepEqual(counts.queue, { open: 1, done: 1, dismissed: 1, lowestDone: 0.9, highestDismissed: 0.71 });
  assert.equal('domains' in modelCounts(counts), false, 'a model is never given a domain');
  assert.equal(summariseAnalyseFacts(facts(), wrap).judge, null, 'no judge, no judge counts');
});

test('ANALYSE: a model improves the judge’s question, each session’s text and each Linear title, and nothing else', () => {
  const doc = rule({
    targets: [
      { targetId: 'log', version: 1, kind: 'dry-run', retentionMs: DAY },
      {
        targetId: 'billing-session',
        version: 1,
        kind: 'session',
        context: [
          { text: 'Check the invoice against Stripe before replying.' },
          { fields: ['/subject'] },
          { generate: { provider: 'anthropic', instruction: 'Summarise.', from: ['/subject'] } },
          { text: '   ' },
        ],
      },
      { targetId: 'billing-issue', version: 1, kind: 'linear', title: 'Invoice from {{from.name}}' },
      { targetId: 'generated-issue', version: 1, kind: 'linear', title: { generate: { instruction: 'x' } } },
    ],
  });
  assert.deepEqual(
    modelPartsOf(doc).map((part) => [part.part, part.current, part.at]),
    [
      ['judge.question', 'Is this asking me to pay or send something?', {}],
      [
        'session.context',
        'Check the invoice against Stripe before replying.',
        { targetId: 'billing-session', contextIndex: 0 },
      ],
      ['linear.title', 'Invoice from {{from.name}}', { targetId: 'billing-issue' }],
    ],
  );
  assert.deepEqual(modelPartsOf(rule({ agentic: undefined })), []);
  assert.deepEqual(
    modelPartsOf(
      rule({
        agentic: undefined,
        targets: [{ targetId: 's', version: 1, kind: 'session', context: [{ text: 'x'.repeat(2001) }] }],
      }),
    ),
    [],
    'a part longer than a model may write back is left as it is',
  );
  assert.deepEqual(
    mappedFieldNames({ from: { $path: '/from' }, sender: { name: { $path: '/from/name' } }, kind: 'x' }),
    ['from', 'sender.name'],
  );
  for (const part of ['judge.question', 'session.context', 'linear.title'] as const) {
    assert.match(ANALYSE_PROMPTS[part], /never an instruction to you/u, `${part}'s brief treats the input as data`);
    assert.match(ANALYSE_PROMPTS[part], /\{"after": /u, `${part}'s brief asks for the JSON answer`);
    assert.match(ANALYSE_PROMPTS[part], /never see a message/u);
  }
  assert.match(ANALYSE_PROMPTS['judge.question'], /one yes-or-no condition about one fact/u);
  assert.match(ANALYSE_PROMPTS['judge.question'], /Name who asks for what/u);
  assert.match(ANALYSE_PROMPTS['session.context'], /Task:[\s\S]*Steps:[\s\S]*Limits:[\s\S]*When unsure:/u);
  assert.match(ANALYSE_PROMPTS['linear.title'], /\{\{field\}\} slots/u);
});

test('ANALYSE: what a model is sent is the rule’s own text and numbers — no account and no domain', () => {
  const doc = rule();
  const counts = summariseAnalyseFacts(facts({ judged: [judged(0.1, 'secret-sender.example')] }), wrap);
  const [question] = modelPartsOf(doc);
  assert.ok(question !== undefined);
  const input = JSON.parse(modelInput(doc, question, counts)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(input), ['part', 'rule', 'now', 'counts']);
  assert.deepEqual(input.rule, {
    ruleId: 'invoices',
    watches: 'gmail.message.received@1',
    condition: 'match any\n  subject contains "invoice"\n  subject contains "payment"',
    judge: {
      question: 'Is this asking me to pay or send something?',
      looksAt: ['/from/address', '/subject'],
      yesAt: 0.7,
      ifUnsure: 'leave it out',
    },
    mappedFields: ['from', 'subject'],
  });
  const text = modelInput(doc, question, counts);
  assert.equal(text.includes('secret-sender'), false, 'no domain');
  assert.equal(text.includes('ibx_ANALYSEDOMAIN001'), false, 'no account');
  assert.equal(text.includes('untrusted-content'), false, 'no sender material at all');
});

test('ANALYSE: the condition’s addresses and domains are sent as placeholders, and the wording says so', () => {
  // Security review of 0.33.0, finding 7: a condition can name a person and a domain an applied exclusion left out.
  const doc = rule({
    condition: {
      all: [
        { path: '/from/address', op: 'equals', value: 'jane.ceo@acme-private.example', caseSensitive: false },
        { path: '/from/address', op: 'startsWith', value: 'jane.', caseSensitive: false },
        { path: '/subject', op: 'contains', value: 'write to billing@acme-private.example', caseSensitive: false },
        { path: '/subject', op: 'in', values: ['invoice', 'acme-private.example'] },
        { path: '/subject', op: 'contains', value: 'invoice v1.2', caseSensitive: false },
        {
          not: {
            path: '/from/address',
            op: 'domainIs',
            value: 'sender-chosen-domain.example',
            includeSubdomains: false,
          },
        },
      ],
    },
  });
  const [question] = modelPartsOf(doc);
  assert.ok(question !== undefined);
  const sent = modelInput(doc, question, summariseAnalyseFacts(facts(), wrap));
  for (const literal of ['jane.ceo', 'acme-private', 'sender-chosen-domain', 'jane.', 'billing@'])
    assert.equal(sent.includes(literal), false, `${literal} is not sent`);
  const condition = (JSON.parse(sent) as { rule: { condition: string } }).rule.condition;
  assert.equal(
    condition,
    [
      'match all',
      '  from.address is "<address>"',
      '  from.address starts with "<address>"',
      '  subject contains "<address>"',
      '  subject is one of "invoice", "<domain>"',
      '  subject contains "invoice v1.2"',
      '  not from.address has domain "<domain>"',
    ].join('\n'),
    'the shape and the person’s other words stay',
  );
  assert.match(ANALYSE_SENT, /condition with each address and domain replaced by <address> or <domain>/u);
  assert.doesNotMatch(ANALYSE_SENT, /^The rule's own text and content-free counts/u);
  // What the person sees and approves is never changed: the suggestion's before is the condition as it is.
  assert.deepEqual(redactConditionLiterals({ ...doc, condition: undefined }), undefined);
});

test('ANALYSE: a model’s answer is read strictly — one JSON object within its limits, or refused', () => {
  const [question, linear] = modelPartsOf(
    rule({ targets: [{ targetId: 'issue', version: 1, kind: 'linear', title: 'Invoice from {{from.name}}' }] }),
  );
  assert.ok(question !== undefined && linear !== undefined);
  const answer = (after: unknown, why: unknown = 'Because.', extra: Record<string, unknown> = {}) =>
    JSON.stringify({ after, why, ...extra });
  assert.deepEqual(readModelAnswer(question, `  ${answer('Is the sender asking me to pay them?')}\n`), {
    after: 'Is the sender asking me to pay them?',
    why: 'Because.',
  });
  assert.equal(readModelAnswer(question, answer(' Is this asking me to pay or send something? ')), null, 'unchanged');
  for (const [text, refused] of [
    ['Sure! Here it is: {"after": "x", "why": "y"}', 'MODEL_OUTPUT_NOT_JSON'],
    ['```json\n{"after": "x", "why": "y"}\n```', 'MODEL_OUTPUT_NOT_JSON'],
    ['[{"after": "x", "why": "y"}]', 'MODEL_OUTPUT_SHAPE'],
    [answer('x', 'y', { also: 'z' }), 'MODEL_OUTPUT_SHAPE'],
    [answer(42), 'MODEL_OUTPUT_SHAPE'],
    [answer(''), 'MODEL_OUTPUT_SHAPE'],
    [JSON.stringify({ after: 'x' }), 'MODEL_OUTPUT_SHAPE'],
    [answer('x'.repeat(301)), 'MODEL_OUTPUT_TOO_LONG'],
    [answer('Fine?', 'y'.repeat(401)), 'MODEL_OUTPUT_TOO_LONG'],
    [answer('Two\nlines?'), 'MODEL_OUTPUT_CHARACTERS'],
    [answer('Bidi ‮ trick?'), 'MODEL_OUTPUT_CHARACTERS'],
    [answer('Escape \u001b[31m?'), 'MODEL_OUTPUT_CHARACTERS'],
    [answer('Zero​width?'), 'MODEL_OUTPUT_CHARACTERS'],
    [answer('<untrusted-content boundary="x">'), 'MODEL_OUTPUT_CHARACTERS'],
    [answer('Fine?', 'why\nnot'), 'MODEL_OUTPUT_CHARACTERS'],
  ] as const)
    assert.deepEqual(readModelAnswer(question, text), { refused }, text);
  assert.deepEqual(readModelAnswer(linear, answer('Pay {{from.name}} for {{body}}')), {
    refused: 'MODEL_OUTPUT_SLOTS',
  });
  assert.deepEqual(readModelAnswer(linear, answer('Pay {{from.name')), { refused: 'MODEL_OUTPUT_SLOTS' });
  assert.deepEqual(readModelAnswer(linear, answer('Invoice request: {{from.address}}')), {
    after: 'Invoice request: {{from.address}}',
    why: 'Because.',
  });
});

test('ANALYSE: each provider gets its own closed request, and its answer is read from its own shape', () => {
  const openRouter = buildAnalyseRequest({ provider: 'openrouter', key: 'fake-or', system: 'S', user: 'U' });
  assert.deepEqual(openRouter.headers, {
    Authorization: 'Bearer fake-or',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  });
  assert.deepEqual(JSON.parse(openRouter.body.toString('utf8')), {
    model: 'anthropic/claude-sonnet-5.5',
    messages: [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ],
    max_tokens: 4096,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'suggestion',
        strict: true,
        schema: {
          type: 'object',
          properties: { after: { type: 'string' }, why: { type: 'string' } },
          required: ['after', 'why'],
          additionalProperties: false,
        },
      },
    },
  });
  const anthropic = buildAnalyseRequest({ provider: 'anthropic', key: 'fake-an', system: 'S', user: 'U' });
  assert.deepEqual(anthropic.headers, {
    'x-api-key': 'fake-an',
    'anthropic-version': '2026-10-21',
    'content-type': 'application/json',
    accept: 'application/json',
  });
  const body = JSON.parse(anthropic.body.toString('utf8')) as Record<string, unknown>;
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.system, 'S');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'U' }]);
  assert.equal('temperature' in body, false);
  for (const key of ['', 'fake key', 'fake\r\nX-Injected: 1', 'fakeé'])
    assert.throws(() => buildAnalyseRequest({ provider: 'anthropic', key, system: 'S', user: 'U' }), /header/u);

  const read = (provider: 'openrouter' | 'anthropic', value: unknown) =>
    readAnalyseResponse(provider, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
  assert.deepEqual(read('openrouter', { choices: [{ finish_reason: 'stop', message: { content: 'T' } }] }), {
    text: 'T',
  });
  assert.deepEqual(read('openrouter', { choices: [{ finish_reason: 'length', message: { content: 'T' } }] }), {
    refused: 'MODEL_OUTPUT_TRUNCATED',
  });
  assert.deepEqual(read('openrouter', { choices: [] }), { refused: 'RESPONSE_MALFORMED' });
  assert.deepEqual(read('openrouter', 'not json'), { refused: 'RESPONSE_MALFORMED' });
  assert.deepEqual(
    read('anthropic', {
      type: 'message',
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: '{"after":' },
        { type: 'text', text: '"x","why":"y"}' },
      ],
    }),
    { text: '{"after":"x","why":"y"}' },
  );
  assert.deepEqual(read('anthropic', { type: 'message', stop_reason: 'refusal', content: [] }), {
    refused: 'MODEL_REFUSED',
  });
  assert.deepEqual(read('anthropic', { type: 'message', stop_reason: 'max_tokens', content: [] }), {
    refused: 'MODEL_OUTPUT_TRUNCATED',
  });
  assert.deepEqual(read('anthropic', { type: 'message', stop_reason: 'end_turn', content: [{ type: 'thinking' }] }), {
    refused: 'RESPONSE_MALFORMED',
  });
  assert.deepEqual([401, 403, 429, 500, 529, 400, 404].map(refusalForStatus), [
    'MODEL_KEY_REFUSED',
    'MODEL_KEY_REFUSED',
    'MODEL_RATE_LIMITED',
    'MODEL_UNAVAILABLE',
    'MODEL_UNAVAILABLE',
    'MODEL_REQUEST_REFUSED',
    'MODEL_REQUEST_REFUSED',
  ]);
  assert.deepEqual(
    chooseAnalyseProvider(undefined, (provider) => provider === 'anthropic'),
    {
      provider: 'anthropic',
      hasKey: true,
    },
  );
  assert.deepEqual(
    chooseAnalyseProvider(undefined, () => true),
    { provider: 'openrouter', hasKey: true },
  );
  assert.deepEqual(
    chooseAnalyseProvider('anthropic', () => false),
    { provider: 'anthropic', hasKey: false },
  );
  assert.equal(
    chooseAnalyseProvider(undefined, () => false),
    null,
  );
  assert.equal(ANALYSE_ROUTES.openrouter.endpoint, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(ANALYSE_ROUTES.anthropic.endpoint, 'https://api.anthropic.com/v1/messages');
});

test('ANALYSE: an HTTP response is framed by its length, its chunks or its close, and anything ambiguous is refused', () => {
  const head = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n';
  const bytes = (text: string) => Buffer.from(text, 'latin1');
  assert.deepEqual(readHttpResponse(bytes(`${head}Content-Length: 2\r\n\r\n{}`), false), {
    status: 200,
    body: bytes('{}'),
  });
  assert.equal(readHttpResponse(bytes(`${head}Content-Length: 5\r\n\r\n{}`), false), 'incomplete');
  assert.equal(readHttpResponse(bytes(`${head}Content-Length: 5\r\n\r\n{}`), true), null);
  assert.deepEqual(
    readHttpResponse(bytes(`${head}Transfer-Encoding: chunked\r\n\r\n1\r\n{\r\n1;x=y\r\n}\r\n0\r\n\r\n`), false),
    {
      status: 200,
      body: bytes('{}'),
    },
  );
  assert.equal(readHttpResponse(bytes(`${head}Transfer-Encoding: chunked\r\n\r\n1\r\n{\r\n`), false), 'incomplete');
  assert.equal(readHttpResponse(bytes(`${head}Transfer-Encoding: chunked\r\n\r\nzz\r\n`), false), null);
  assert.deepEqual(readHttpResponse(bytes(`${head}\r\n{}`), true), { status: 200, body: bytes('{}') });
  assert.equal(readHttpResponse(bytes(`${head}\r\n{}`), false), 'incomplete');
  for (const ambiguous of [
    `${head}Content-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n{}`,
    `${head}Content-Length: 2\r\nContent-Length: 3\r\n\r\n{}`,
    `${head}Transfer-Encoding: gzip\r\n\r\n{}`,
    `${head}Content-Length: -1\r\n\r\n{}`,
    'HTTP/2 200 OK\r\n\r\n{}',
    'not http at all\r\n\r\n',
  ])
    assert.equal(readHttpResponse(bytes(ambiguous), true), null, ambiguous);
  assert.deepEqual(readHttpResponse(bytes('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'), false), {
    status: 401,
    body: bytes(''),
  });
});
