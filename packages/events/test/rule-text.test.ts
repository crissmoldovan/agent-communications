import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATALOGUE, type JsonObject, parseRuleText, printRuleText, RULE_RETENTION_DEFAULTS } from '../src/index.ts';

/**
 * The rule text (0.33.0 design §3.2): `printRuleText` writes a rule document as the prototype's small language, and
 * `parseRuleText` reads it back to the same document. Each section has its examples here; every rule fixture in the
 * repository is in `rule-text-fixtures.test.ts`, and generated documents in `rule-text-property.test.ts`.
 */

const DAY = 86_400_000;

/** The design's defaults (local-event-emission design, D2): what a rule keeps when its text says nothing. */
const DEFAULT_RETENTION = {
  ingestMs: 7 * DAY,
  holdMs: 7 * DAY,
  deliveryMs: 7 * DAY,
  dryrunMs: DAY,
  sseReplayMs: 7 * DAY,
  deadLetterMs: 7 * DAY,
  decisionMetadataMs: 90 * DAY,
};

const SHORT_RETENTION = {
  ingestMs: 60_000,
  holdMs: 60_000,
  deliveryMs: 3_600_000,
  dryrunMs: 3_600_000,
  sseReplayMs: 60_000,
  deadLetterMs: 60_000,
  decisionMetadataMs: 60_000,
};

function rule(overrides: Record<string, unknown> = {}): JsonObject {
  return {
    ruleId: 'invoices',
    version: 3,
    source: {
      channel: 'gmail',
      accountIds: ['cue/gmail'],
      options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
    mapping: { subject: { $path: '/subject' } },
    targets: [{ targetId: 'invoices-log', version: 1, kind: 'dry-run', retentionMs: DAY }],
    subscribers: [],
    judges: [],
    deliveryRateCap: 60,
    retention: SHORT_RETENTION,
    ...overrides,
  } as JsonObject;
}

/** Prints, parses back, prints again: the document comes back whole, and the text is the same both times. */
function roundTrip(doc: JsonObject): string {
  const text = printRuleText(doc);
  const parsed = parseRuleText(text);
  assert.ok(parsed.ok, `the printed text parses:\n${text}\n${JSON.stringify(parsed)}`);
  assert.deepStrictEqual(parsed.doc, doc, `the document round-trips through:\n${text}`);
  assert.equal(printRuleText(parsed.doc), text, 'printing is stable');
  return text;
}

/** The lines of a printed rule that start with `word`, to check one section without the rest. */
function section(text: string, word: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === word || line.startsWith(`${word} `));
  assert.notEqual(start, -1, `the text has a ${word} section:\n${text}`);
  const out = [lines[start] as string];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ') && line !== '') break;
    out.push(line);
  }
  while (out.at(-1) === '') out.pop();
  return out;
}

test('a rule starts with its id and version, then says when it applies, which messages match, and what happens', () => {
  const text = roundTrip(rule());
  assert.deepEqual(text.split('\n').slice(0, 4), [
    'rule invoices, version 3',
    '',
    'when a new message arrives in cue/gmail, in the inbox',
    'match subject exists',
  ]);
  assert.deepEqual(section(text, 'then'), ['then', '  dry run invoices-log, version 1, keep 1 day']);
  assert.doesNotMatch(text, /^raw /m, 'a canonical rule needs no escape');
});

test('when: every catalogue event has a phrase, and every source option of the four channels is written out', () => {
  const phrases = new Map([
    ['gmail.message.received', 'a new message arrives'],
    ['gmail.message.sent', 'a message is sent'],
    ['gmail.message.labelled', 'a message is labelled'],
    ['slack.message.posted', 'a Slack message is posted'],
    ['resend.email.received', 'a Resend email arrives'],
    ['resend.email.status_changed', 'a Resend email changes status'],
    ['whatsapp.message.received', 'a WhatsApp message arrives'],
  ]);
  const types = [...new Set(CATALOGUE.map((definition) => definition.type))].sort();
  assert.deepEqual([...phrases.keys()].sort(), types, 'one phrase per catalogue event type');
  const options = {
    gmail: [
      [{ labels: 'inbox', includeSpamTrash: false }, ', in the inbox'],
      [{ labels: 'any', includeSpamTrash: true }, ', in any label, including spam and trash'],
      [{ labels: ['Label_1'], includeSpamTrash: false }, ', in label Label_1'],
      [{ labels: ['IMPORTANT', 'Label 2'], includeSpamTrash: false }, ', in labels IMPORTANT and "Label 2"'],
    ],
    slack: [
      [{ conversations: ['C00000001'] }, ', in conversation C00000001'],
      [{ conversations: ['C00000001', 'G-private'] }, ', in conversations C00000001 and G-private'],
    ],
    resend: [
      [{ kinds: ['received'] }, ', kind received'],
      [{ kinds: ['received', 'status'] }, ', kinds received and status'],
    ],
    whatsapp: [
      [{ chats: 'all-allowed' }, ', in all allowed chats'],
      [{ chats: ['447700900000@s.whatsapp.net'] }, ', in chat 447700900000@s.whatsapp.net'],
      [{ chats: ['a@g.us', 'b@g.us'] }, ', in chats a@g.us and b@g.us'],
    ],
  } as const;
  for (const [type, phrase] of phrases) {
    const channel = type.split('.')[0] as keyof typeof options;
    for (const [option, words] of options[channel]) {
      const doc = rule({
        source: { channel, accountIds: ['acc_ONE', 'rgc/x'], options: { channel, ...option } },
        event: { type, version: 1 },
      });
      const text = roundTrip(doc);
      assert.equal(section(text, 'when')[0], `when ${phrase} in acc_ONE and rgc/x${words}`);
    }
  }
});

test('when: an event without a phrase is named, with its version', () => {
  const text = roundTrip(rule({ event: { type: 'gmail.message.received', version: 2 } }));
  assert.equal(section(text, 'when')[0], 'when event "gmail.message.received" version 2 in cue/gmail, in the inbox');
});

test('match: every operator, case sensitivity, not, and nested any and all', () => {
  const condition = {
    any: [
      { path: '/subject', op: 'contains', value: 'invoice', caseSensitive: false },
      { path: '/subject', op: 'contains', value: 'Payment', caseSensitive: true },
      {
        all: [
          { path: '/from/address', op: 'domainIs', value: 'example.test', includeSubdomains: true },
          { path: '/from/address', op: 'domainIs', value: 'example.org', includeSubdomains: false },
          { not: { path: '/labelIds', op: 'contains', value: 'SPAM', caseSensitive: false } },
          {
            not: {
              any: [
                { path: '/to/0/address', op: 'exists' },
                { path: '/cc', op: 'exists' },
              ],
            },
          },
        ],
      },
      { path: '/subject', op: 'equals', value: 'Hello "you"', caseSensitive: false },
      { path: '/subject', op: 'notEquals', value: null, caseSensitive: true },
      { path: '/hasAttachments', op: 'equals', value: true, caseSensitive: false },
      { path: '/subject', op: 'startsWith', value: 'Re:', caseSensitive: false },
      { path: '/subject', op: 'endsWith', value: '!', caseSensitive: true },
      { path: '/sizeEstimate', op: 'in', values: [1, 'two', true, null] },
      { path: '/sizeEstimate', op: 'gt', value: 10 },
      { path: '/sizeEstimate', op: 'gte', value: 1.5 },
      { path: '/internalDate', op: 'lt', value: '2026-10-26T00:00:00Z' },
      { path: '/sizeEstimate', op: 'lte', value: -3 },
      { not: { not: { path: '/id', op: 'exists' } } },
    ],
  };
  const text = roundTrip(rule({ condition }));
  assert.deepEqual(section(text, 'match'), [
    'match any',
    '  subject contains "invoice"',
    '  subject contains "Payment", matching case',
    '  all',
    '    from.address has domain "example.test" or a subdomain',
    '    from.address has domain "example.org"',
    '    not labelIds contains "SPAM"',
    '    not any',
    '      to.0.address exists',
    '      cc exists',
    '  subject is "Hello \\"you\\""',
    '  subject is not null, matching case',
    '  hasAttachments is true',
    '  subject starts with "Re:"',
    '  subject ends with "!", matching case',
    '  sizeEstimate is one of 1, "two", true, null',
    '  sizeEstimate is more than 10',
    '  sizeEstimate is at least 1.5',
    '  internalDate is less than "2026-10-26T00:00:00Z"',
    '  sizeEstimate is at most -3',
    '  not not id exists',
  ]);
});

test('match: a field is a dotted name when it can be, and a JSON Pointer when it cannot', () => {
  const fields = [
    ['/from/address', 'from.address'],
    ['/any', '/any'],
    ['/a-b/c.d', '/a-b/c.d'],
    ['/a~1b', '/a~1b'],
    ['/with space', '"/with space"'],
    ['', '""'],
    ['/', '/'],
  ];
  for (const [path, written] of fields) {
    const text = roundTrip(rule({ condition: { path, op: 'exists' } }));
    assert.equal(section(text, 'match')[0], `match ${written} exists`);
  }
});

test('then: every target kind today, with its options, one block per target', () => {
  const targets = [
    {
      targetId: 'billing',
      version: 2,
      kind: 'queue',
      retentionMs: 7 * DAY,
      show: 'summary',
      lane: { name: 'billing' },
    },
    { targetId: 'quiet', version: 1, kind: 'queue', retentionMs: 30 * DAY, show: 'minimal' },
    { targetId: 'log', version: 1, kind: 'dry-run', retentionMs: 3_600_000 },
    {
      targetId: 'hook',
      version: 4,
      kind: 'webhook',
      url: { kind: 'plain', value: 'https://hooks.example.test:443/in' },
      approvedAddressSet: ['93.184.216.34'],
      signing: 'standard-webhooks',
      ordering: 'strict',
      retryLimit: 5,
      representation: 'enveloped',
    },
    {
      targetId: 'hidden-hook',
      version: 1,
      kind: 'webhook',
      url: { kind: 'secret', scheme: 'https', host: 'hooks.example.test', port: 443, sha256: 'a'.repeat(64) },
      approvedAddressSet: ['2001:db8::1', '93.184.216.34'],
      signing: 'standard-webhooks',
      ordering: 'strict',
      retryLimit: 1,
      representation: 'plain',
    },
    {
      targetId: 'browser',
      version: 1,
      kind: 'sse',
      subscriberId: 'tab',
      subscriberVersion: 2,
      representation: 'plain',
    },
  ];
  const subscribers = [
    {
      subscriberId: 'tab',
      version: 2,
      kind: 'sse',
      authority: { host: '127.0.0.1', port: 8787 },
      origins: ['http://127.0.0.1:5173', 'http://localhost:5173'],
      retentionMs: 60_000,
    },
  ];
  const text = roundTrip(
    rule({ targets, subscribers, mapping: { from: { $path: '/from' }, subject: { $path: '/subject' } } }),
  );
  assert.deepEqual(section(text, 'then'), [
    'then',
    '  queue billing, version 2, in lane billing, keep 7 days',
    '',
    '  queue quiet, version 1, keep 30 days, show minimal',
    '',
    '  dry run log, version 1, keep 1 hour',
    '',
    '  webhook hook, version 4, enveloped, retrying up to 5 times',
    '    to https://hooks.example.test:443/in',
    '    approved address 93.184.216.34',
    '',
    '  webhook hidden-hook, version 1, plain, retrying up to 1 time',
    `    to secret https URL on hooks.example.test port 443, fingerprint ${'a'.repeat(64)}`,
    '    approved addresses 2001:db8::1 and 93.184.216.34',
    '',
    '  stream browser, version 1, to subscriber tab version 2, plain',
  ]);
  assert.deepEqual(section(text, 'subscriber'), [
    'subscriber tab, version 2, on 127.0.0.1 port 8787, keep 1 minute',
    '  origins http://127.0.0.1:5173 and http://localhost:5173',
  ]);
});

const TEAM_ID = '0b6a6f0e-8a8e-4c55-9d7c-6a1c0f8b8c11';
const BILLING_ID = '3e1f8a52-7c1d-4a8e-9f00-2b6c1d4e5f60';
const URGENT_ID = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

test('then: a Linear issue says its team, labels and assignee on its line, and its ids, title and description below', () => {
  const issue = {
    targetId: 'billing-issues',
    version: 2,
    kind: 'linear',
    team: { id: TEAM_ID, key: 'CUE' },
    title: { text: 'Invoice from {{from.address}}' },
    description: { text: 'Check it against Stripe.\n\n{{subject}}' },
    labels: [
      { id: URGENT_ID, name: 'Urgent' },
      { id: BILLING_ID, name: 'Needs triage' },
    ],
    assignee: 'me',
  };
  const text = roundTrip(rule({ targets: [issue] }));
  assert.deepEqual(section(text, 'then'), [
    'then',
    '  linear issue billing-issues, version 2, in team CUE, labels Urgent and "Needs triage", assigned to me',
    `    team id ${TEAM_ID}`,
    `    label ids ${URGENT_ID} and ${BILLING_ID}`,
    '    title "Invoice from {{from.address}}"',
    '    description "Check it against Stripe.\\n\\n{{subject}}"',
  ]);
  // No labels and nobody are what the parser fills, so neither is written; one label, and one user by id.
  assert.deepEqual(
    section(roundTrip(rule({ targets: [{ ...issue, labels: [], assignee: null }] })), 'then').slice(1, 2),
    ['  linear issue billing-issues, version 2, in team CUE'],
  );
  const one = roundTrip(
    rule({ targets: [{ ...issue, labels: [{ id: BILLING_ID, name: 'Billing' }], assignee: { id: URGENT_ID } }] }),
  );
  assert.deepEqual(section(one, 'then').slice(1, 3), [
    `  linear issue billing-issues, version 2, in team CUE, label Billing, assigned to user ${URGENT_ID}`,
    `    team id ${TEAM_ID}`,
  ]);
  assert.match(one, new RegExp(`^    label id ${BILLING_ID}$`, 'mu'));
  // A model-written part, a label without its name, and an assignee by name have no words yet: the target is raw.
  for (const odd of [
    { ...issue, title: { generate: { provider: 'openrouter', instruction: 'Summarise', from: ['/subject'] } } },
    { ...issue, labels: [{ id: BILLING_ID }] },
    { ...issue, labels: [{ id: BILLING_ID, name: 'Billing' }, { name: 'Urgent' }] },
    { ...issue, assignee: 'criss' },
  ])
    assert.match(section(roundTrip(rule({ targets: [odd] })), 'then')[1] as string, /^ {2}raw \{/u);
});

test("then: the prototype's short Linear line parses, leaving out the ids the app fills from Linear", () => {
  const parsed = parseRuleText(
    [
      'rule invoices, version 1',
      'when a new message arrives in cue/gmail, in the inbox',
      'match subject exists',
      'then',
      '  linear issue in team CUE, label Billing, assigned to me',
      '    title "Invoice from {{sender}}"',
    ].join('\n'),
  );
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepStrictEqual(parsed.doc.targets, [
    {
      kind: 'linear',
      team: { key: 'CUE' },
      labels: [{ name: 'Billing' }],
      assignee: 'me',
      title: { text: 'Invoice from {{sender}}' },
    },
  ]);
  // It prints back whole, as raw: a target without its id and version has no line of its own.
  const again = parseRuleText(printRuleText(parsed.doc));
  assert.ok(again.ok);
  assert.deepStrictEqual(again.doc, parsed.doc);
});

test('errors: a Linear issue’s ids pair with its names, a model-written title is not yet, and each part is said once', () => {
  const lines = (...target: string[]) => [...VALID.slice(0, 4), ...target].join('\n');
  assert.deepEqual(errorsOf(lines('  linear issue i, version 1, labels A and B', '    label id x')), [
    { line: 6, column: 5, message: "the issue's line names 2 labels, and this line 1 ids" },
  ]);
  assert.deepEqual(errorsOf(lines('  linear issue i, version 1', '    label ids x and y')), [
    { line: 6, column: 5, message: "label ids pair with the label names on the issue's line, which names none" },
  ]);
  assert.deepEqual(errorsOf(lines('  linear issue i, version 1', '    title written by claude "Say it"')), [
    {
      line: 6,
      column: 11,
      message:
        "a model-written title arrives with the session target's context; for now write the title as quoted text with {{field}} slots",
    },
  ]);
  assert.deepEqual(errorsOf(lines('  linear issue i, version 1, label A, labels B')), [
    { line: 5, column: 39, message: 'a Linear issue names its labels once' },
  ]);
  assert.deepEqual(errorsOf(lines('  linear issue i, version 1, assigned to someone')), [
    { line: 5, column: 42, message: 'expected me, nobody or user <id> after "assigned to"; found "someone"' },
  ]);
  assert.deepEqual(errorsOf(lines('  linear issue i, version 1', '    priority 1')), [
    {
      line: 6,
      column: 5,
      message: 'a Linear issue\'s lines are team id, label id, label ids, title and description; found "priority"',
    },
  ]);
});

test('names are bare when they can be, and quoted when they have other characters or are a word a name could end at', () => {
  const text = roundTrip(
    rule({
      ruleId: 'the rule',
      source: {
        channel: 'gmail',
        accountIds: ['and', 'café', 'version'],
        options: { channel: 'gmail', labels: ['"quoted"', 'port', 'status'], includeSpamTrash: false },
      },
    }),
  );
  assert.equal(section(text, 'rule')[0], 'rule "the rule", version 3');
  assert.equal(
    section(text, 'when')[0],
    'when a new message arrives in "and" and "café" and "version", in labels "\\"quoted\\"" and "port" and status',
  );
});

test('raw: whatever the readable form cannot say is kept as JSON, so nothing is ever dropped', () => {
  const odd = rule({
    extra: { note: 'kept' },
    judges: [{ judgeId: 'legacy', version: 1 }],
    condition: {
      all: [
        { path: '/subject', op: 'contains', value: 'x' },
        { path: '/subject', op: 'exists' },
      ],
    },
    targets: [
      { targetId: 'q', version: 1, kind: 'queue', retentionMs: DAY },
      { targetId: 'later', version: 1, kind: 'linear', team: { id: 't', key: 'CUE' } },
    ],
  });
  const text = roundTrip(odd);
  assert.deepEqual(section(text, 'match'), [
    'match all',
    '  raw {"op":"contains","path":"/subject","value":"x"}',
    '  subject exists',
  ]);
  assert.deepEqual(section(text, 'then'), [
    'then',
    '  raw {"kind":"queue","retentionMs":86400000,"targetId":"q","version":1}',
    '',
    '  raw {"kind":"linear","targetId":"later","team":{"id":"t","key":"CUE"},"version":1}',
  ]);
  assert.match(text, /^raw \/extra = \{"note":"kept"\}$/m);
  assert.match(text, /^raw \/judges = \[\{"judgeId":"legacy","version":1\}\]$/m);
});

test('raw: a field the document lacks is written as absent, so even a partial fixture round-trips', () => {
  const partial = {
    ruleId: 'rule-browser-sse',
    version: 1,
    targets: [{ targetId: 't', version: 1, kind: 'dry-run', retentionMs: 60_000 }],
    deliveryRateCap: 20,
  } as JsonObject;
  const text = roundTrip(partial);
  for (const field of ['source', 'event', 'condition', 'judges', 'subscribers', 'retention'])
    assert.match(text, new RegExp(`^raw /${field} absent$`, 'm'), field);
  roundTrip({ ruleId: 'x', version: 1, targets: [] } as JsonObject);
  roundTrip({} as JsonObject);
});

test('printing refuses what is not a JSON object', () => {
  for (const value of [[], null, 'rule', { when: undefined, bad: Number.NaN }])
    assert.throws(() => printRuleText(value as JsonObject), /JSON object|non-finite/);
});

const JEV = {
  judgeId: 'jev',
  version: 2,
  kind: 'typesafe',
  provider: 'typesafe',
  model: 'jev-1.13.0',
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  promptTemplate: 'typesafe-jev-noul-v1',
  protocol: 'noul',
};

const LIMITS = {
  callsPerRollingHour: 60,
  inputTokensPerRolling30Days: 1_000_000,
  concurrency: 1,
  maxInputTokens: 2000,
  maxOutputTokens: 16,
};

test('ask: the judge, its question, what it looks at, its bar, its limits and the judge document it embeds', () => {
  const agentic = {
    judge: JEV,
    question: 'Is this asking me to pay or send something?',
    inputs: ['/from/address', '/subject', '/snippet'],
    threshold: 0.7,
    onUncertain: 'no-match',
    ...LIMITS,
  };
  assert.deepEqual(section(roundTrip(rule({ agentic })), 'ask'), [
    'ask jev, version 2, via typesafe',
    '  question "Is this asking me to pay or send something?"',
    '  looking at from.address, subject, snippet',
    '  yes at 0.7, if unsure drop',
    '  at most 60 calls an hour, 1000000 input tokens in 30 days, 1 at a time',
    '  each call up to 2000 tokens in and 16 tokens out',
    '  judge typesafe, model jev-1.13.0',
    '    endpoint https://api.typesafe.ai/v1/systemone',
    '    prompt template typesafe-jev-noul-v1',
    '    protocol noul',
  ]);
});

test('ask: a local judge with its address and score pointer, a Laya judge, holding when unsure, looking at nothing', () => {
  const local = {
    judge: {
      judgeId: 'local',
      version: 1,
      kind: 'local-endpoint',
      provider: 'ollama',
      model: 'llama3.2:3b',
      endpoint: 'http://127.0.0.1:11434/api/generate',
      approvedAddressSet: ['127.0.0.1'],
      promptTemplate: 'ollama-json-score-v1',
      protocol: 'json-score',
      scorePointer: '/score',
    },
    question: 'Does the sender want a reply?',
    inputs: ['/subject'],
    threshold: 0.5,
    onUncertain: 'hold',
    ...LIMITS,
    concurrency: 3,
  };
  assert.deepEqual(section(roundTrip(rule({ agentic: local })), 'ask'), [
    'ask local, version 1, via ollama',
    '  question "Does the sender want a reply?"',
    '  looking at subject',
    '  yes at 0.5, if unsure hold',
    '  at most 60 calls an hour, 1000000 input tokens in 30 days, 3 at a time',
    '  each call up to 2000 tokens in and 16 tokens out',
    '  judge local-endpoint, model llama3.2:3b',
    '    endpoint http://127.0.0.1:11434/api/generate',
    '    approved address 127.0.0.1',
    '    prompt template ollama-json-score-v1',
    '    protocol json-score',
    '    score at score',
  ]);
  const laya = {
    judge: {
      judgeId: 'laya-1',
      version: 1,
      kind: 'laya',
      provider: 'laya',
      model: 'laya-en-onnx-68f27dfe',
      promptTemplate: 'laya-yes-no-v1',
    },
    question: 'Reply needed?',
    inputs: [],
    threshold: 1,
    onUncertain: 'no-match',
    callsPerRollingHour: 1,
    inputTokensPerRolling30Days: 1,
    concurrency: 1,
    maxInputTokens: 1,
    maxOutputTokens: 1,
  };
  assert.deepEqual(section(roundTrip(rule({ agentic: laya })), 'ask'), [
    'ask laya-1, version 1, via laya',
    '  question "Reply needed?"',
    '  looking at nothing',
    '  yes at 1, if unsure drop',
    '  at most 1 call an hour, 1 input token in 30 days, 1 at a time',
    '  each call up to 1 token in and 1 token out',
    '  judge laya, model laya-en-onnx-68f27dfe',
    '    prompt template laya-yes-no-v1',
  ]);
});

test("ask: the prototype's short ask parses, and leaves out what it does not say for the event service to refuse", () => {
  const text = [
    'rule invoices, version 1',
    'when a new message arrives in cue/gmail, in the inbox',
    'match subject mentions "invoice"',
    'ask jev, version 1, via typesafe',
    '  question "Is this asking me to pay or send something?"',
    '  looking at from.address, subject',
    '  yes at 0.70, if unsure drop',
    'then',
    '  queue billing, version 1, in lane billing, keep 7 days',
  ].join('\n');
  const parsed = parseRuleText(text);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepEqual(parsed.doc.agentic, {
    judge: { judgeId: 'jev', version: 1, provider: 'typesafe' },
    question: 'Is this asking me to pay or send something?',
    inputs: ['/from/address', '/subject'],
    threshold: 0.7,
    onUncertain: 'no-match',
  });
  assert.deepEqual(parsed.doc.condition, { path: '/subject', op: 'contains', value: 'invoice', caseSensitive: false });
});

test('ask: an agentic part the readable form cannot say is raw, whole', () => {
  const text = roundTrip(rule({ agentic: { judge: JEV, question: 'q', inputs: ['/subject'], threshold: 'high' } }));
  assert.match(text, /^raw \/agentic = \{.*"threshold":"high".*\}$/m);
  assert.doesNotMatch(text, /^ask /m);
  roundTrip(rule({ agentic: { judge: { ...JEV, extra: true }, question: 'q' } }));
  roundTrip(rule({ agentic: { question: 'no judge' } }));
});

test('keep: the fields a rule keeps, where it keeps them, what happens when one is missing, and fixed values', () => {
  const mapping = {
    subject: { $path: '/subject' },
    from: { address: { $path: '/from/address' }, name: { $path: '/from/name', missing: 'null' } },
    sender: { $path: '/from/address', missing: 'omit' },
    channel: { id: { $path: '/channel/id' } },
    kind: 'invoice',
    count: 3,
    tags: ['a', { $path: '/subject' }],
    empty: {},
    'odd key': { $path: '/subject' },
    whole: { $path: '' },
    weird: { $path: '/x', missing: 'reject' },
    notReference: { $path: 7 },
  };
  assert.deepEqual(section(roundTrip(rule({ mapping })), 'keep'), [
    'keep channel.id, count = 3, empty = {}, from.address, from.name if missing null, kind = "invoice", notReference = {"$path":7}, subject as "odd key", from.address as sender if missing omit, subject, tags = ["a",{"$path":"/subject"}], x as weird if missing reject, "" as whole',
  ]);
  assert.deepEqual(section(roundTrip(rule({ mapping: {} })), 'keep'), ['keep nothing']);
  assert.deepEqual(section(roundTrip(rule({ mapping: { constant: 'safe' } })), 'keep'), ['keep constant = "safe"']);
  for (const mapping of [{ $path: '/subject' }, 'all of it', ['/subject']])
    assert.match(
      roundTrip(rule({ mapping })),
      /^raw \/mapping = /m,
      'a mapping that is not an object of fields is raw',
    );
});

test('at most, cloud event type: the hourly cap and the CloudEvent type the rule sends as', () => {
  const text = roundTrip(rule({ deliveryRateCap: 1, cloudEventType: 'com.example.invoice' }));
  assert.equal(section(text, 'at')[0], 'at most 1 an hour');
  assert.equal(section(text, 'cloud')[0], 'cloud event type "com.example.invoice"');
});

test('the retention defaults have one owner, this package, and the rule text fills from it', () => {
  assert.deepEqual(RULE_RETENTION_DEFAULTS, { ...DEFAULT_RETENTION, queueMs: 7 * DAY });
  assert.ok(Object.isFrozen(RULE_RETENTION_DEFAULTS));
});

test('keep for: retention says only what differs from the defaults, and the parser fills the rest', () => {
  assert.doesNotMatch(roundTrip(rule({ retention: DEFAULT_RETENTION })), /keep for/);
  assert.deepEqual(section(roundTrip(rule()), 'keep for'), [
    'keep for',
    '  events 1 minute',
    '  held events 1 minute',
    '  deliveries 1 hour',
    '  dry runs 1 hour',
    '  stream replay 1 minute',
    '  dead letters 1 minute',
    '  decisions 1 minute',
  ]);
  const queued = (retention: object) =>
    rule({
      retention,
      mapping: { from: { $path: '/from' }, subject: { $path: '/subject' } },
      targets: [{ targetId: 'q', version: 1, kind: 'queue', retentionMs: 7 * DAY, show: 'summary' }],
    });
  assert.doesNotMatch(roundTrip(queued({ ...DEFAULT_RETENTION, queueMs: 7 * DAY })), /keep for/);
  assert.deepEqual(section(roundTrip(queued({ ...DEFAULT_RETENTION, queueMs: 3 * DAY, holdMs: DAY })), 'keep for'), [
    'keep for',
    '  held events 1 day',
    '  queue items 3 days',
  ]);
  assert.match(roundTrip(queued(DEFAULT_RETENTION)), /^raw \/retention = /m, 'a queued rule without queueMs is raw');
  assert.deepEqual(section(roundTrip(rule({ retention: { ...DEFAULT_RETENTION, queueMs: DAY } })), 'keep for'), [
    'keep for',
    '  queue items 1 day',
  ]);
  const parsed = parseRuleText(
    'rule r, version 1\nwhen a new message arrives in a, in the inbox\nmatch subject exists\nthen\n  dry run d, version 1\n',
  );
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.doc.retention, DEFAULT_RETENTION);
  assert.deepEqual([parsed.doc.subscribers, parsed.doc.judges], [[], []]);
});

/** The prototype's invoices rule (RuleEditText), as close as today's targets allow: a lane queue and a dry run. */
const INVOICES = rule({
  ruleId: 'invoices',
  version: 4,
  condition: {
    any: [
      { path: '/subject', op: 'contains', value: 'invoice', caseSensitive: false },
      { path: '/subject', op: 'contains', value: 'payment', caseSensitive: false },
    ],
  },
  agentic: {
    judge: JEV,
    question: 'Is this asking me to pay or send something?',
    inputs: ['/from/address', '/subject', '/snippet'],
    threshold: 0.7,
    onUncertain: 'no-match',
    ...LIMITS,
  },
  mapping: {
    from: { address: { $path: '/from/address' }, name: { $path: '/from/name' } },
    subject: { $path: '/subject' },
    snippet: { $path: '/snippet' },
  },
  targets: [
    {
      targetId: 'billing',
      version: 1,
      kind: 'queue',
      retentionMs: 7 * DAY,
      show: 'summary',
      lane: { name: 'billing' },
    },
    { targetId: 'invoices-log', version: 1, kind: 'dry-run', retentionMs: DAY },
  ],
  retention: { ...DEFAULT_RETENTION, queueMs: 7 * DAY },
});

test("the prototype's invoices rule prints as the prototype draws it, where today's targets allow", () => {
  assert.equal(
    roundTrip(INVOICES),
    `rule invoices, version 4

when a new message arrives in cue/gmail, in the inbox
match any
  subject contains "invoice"
  subject contains "payment"

ask jev, version 2, via typesafe
  question "Is this asking me to pay or send something?"
  looking at from.address, subject, snippet
  yes at 0.7, if unsure drop
  at most 60 calls an hour, 1000000 input tokens in 30 days, 1 at a time
  each call up to 2000 tokens in and 16 tokens out
  judge typesafe, model jev-1.13.0
    endpoint https://api.typesafe.ai/v1/systemone
    prompt template typesafe-jev-noul-v1
    protocol noul

then
  queue billing, version 1, in lane billing, keep 7 days

  dry run invoices-log, version 1, keep 1 day

keep from.address, from.name, snippet, subject
at most 60 an hour
`,
  );
});

const VALID = [
  'rule invoices, version 1',
  'when a new message arrives in cue/gmail, in the inbox',
  'match subject exists',
  'then',
  '  dry run log, version 1, keep 1 day',
];

function errorsOf(text: string) {
  const parsed = parseRuleText(text);
  assert.equal(parsed.ok, false, `the text is refused:\n${text}`);
  return parsed.ok ? [] : parsed.errors;
}

test('errors: the valid text these cases change parses', () => {
  assert.ok(parseRuleText(VALID.join('\n')).ok);
});

test('errors: an unknown keyword is named where it stands, with the keyword it is closest to', () => {
  const text = [...VALID.slice(0, 3), 'thne', '  dry run log, version 1'].join('\n');
  assert.deepEqual(errorsOf(text), [
    {
      line: 4,
      column: 1,
      message:
        'unknown keyword "thne"; did you mean "then"? A line here starts with rule, when, match, ask, then, keep, keep for, at most, cloud event type, subscriber or raw',
    },
    {
      line: 6,
      column: 1,
      message: 'a rule says what happens to a match: then, with each target on its own indented line below it',
    },
  ]);
  const [phrase] = errorsOf([...VALID, 'atmost 60 an hour'].join('\n'));
  assert.match(phrase?.message ?? '', /^unknown keyword "atmost"; did you mean "at most"\?/);
  const [unrelated] = errorsOf([...VALID, 'zebra'].join('\n'));
  assert.match(unrelated?.message ?? '', /^unknown keyword "zebra"\. A line here starts with/);
  const [target] = errorsOf([...VALID.slice(0, 4), '  queu log, version 1'].join('\n'));
  assert.deepEqual(target, {
    line: 5,
    column: 3,
    message:
      'a target starts with dry run, queue, webhook, stream, session, linear issue or raw; found "queu". Did you mean "queue"?',
  });
  const [inAsk] = errorsOf([...VALID, 'ask jev, version 1', '  questoin "x"'].join('\n'));
  assert.deepEqual(inAsk, {
    line: 7,
    column: 3,
    message:
      'an ask\'s lines are question, looking at, yes at, if unsure, at most, each call up to and judge; found "questoin". Did you mean "question"?',
  });
});

test('errors: a bad indent is named on its own line, and does not cost the lines under it', () => {
  assert.deepEqual(errorsOf([...VALID.slice(0, 4), '   dry run log, version 1'].join('\n')), [
    { line: 5, column: 1, message: 'indent by two spaces per level; this line is indented by 3' },
  ]);
  assert.deepEqual(errorsOf([...VALID.slice(0, 4), '    dry run log, version 1'].join('\n')), [
    {
      line: 5,
      column: 5,
      message:
        'this line is indented two levels deeper than the line above it; indent one level (two spaces) at a time',
    },
  ]);
  assert.deepEqual(errorsOf([VALID[0], '  match subject exists', ...VALID.slice(1)].join('\n')), [
    { line: 2, column: 3, message: 'unexpected indent: the rule line has no lines indented under it' },
  ]);
  assert.deepEqual(errorsOf(VALID.join('\n').replace('  dry run', '\tdry run')), [
    { line: 5, column: 1, message: 'indent with spaces, two per level; this line has a tab in its indentation' },
  ]);
});

test('errors: a missing then, when or rule line is named, at the end of the text or at its start', () => {
  assert.deepEqual(errorsOf(VALID.slice(0, 3).join('\n')), [
    {
      line: 4,
      column: 1,
      message: 'a rule says what happens to a match: then, with each target on its own indented line below it',
    },
  ]);
  assert.deepEqual(errorsOf([VALID[0], ...VALID.slice(2)].join('\n')), [
    {
      line: 5,
      column: 1,
      message: 'a rule says when it applies: when a new message arrives in <account>, in the inbox',
    },
  ]);
  assert.deepEqual(errorsOf(VALID.slice(1).join('\n')), [
    { line: 1, column: 1, message: "a rule's text starts with its id and version: rule <id>, version <n>" },
  ]);
  assert.deepEqual(errorsOf([...VALID.slice(0, 3), 'then'].join('\n')), [
    { line: 4, column: 1, message: 'then needs at least one target, each on its own line indented under it' },
  ]);
});

test('errors: each mistake is reported, in order, with the column of what is wrong', () => {
  const text = [
    'rule invoices',
    'when a new message arrives in cue/gmail',
    'match subject contains "unclosed',
    'then',
    '  dry run log, version 1, keep 7 weeks',
    '  session triage, version 1',
    'raw /a/b = 1',
  ].join('\n');
  assert.deepEqual(errorsOf(text), [
    { line: 1, column: 14, message: 'expected ", version <n>" after the rule id, found the end of the line' },
    {
      line: 2,
      column: 40,
      message: 'after the accounts, say which mail: in the inbox, in any label, or in labels <label> and <label>',
    },
    { line: 3, column: 24, message: 'the value has no closing quote' },
    {
      line: 5,
      column: 34,
      message:
        'how long a dry run keeps a record is a duration such as 7 days: days, hours, minutes, seconds or milliseconds',
    },
    {
      line: 6,
      column: 28,
      message: 'a session says where it is found: working in <folder>, or in lane <name>',
    },
    { line: 7, column: 5, message: 'raw names one top-level field as a JSON Pointer, such as /retention' },
  ]);
});

test('errors: a section given twice, and a field given by a section and by raw, are refused', () => {
  assert.deepEqual(errorsOf([...VALID, 'match subject exists'].join('\n')), [
    { line: 6, column: 1, message: 'a rule has one match section; this repeats the one on line 3' },
  ]);
  assert.deepEqual(errorsOf([...VALID, 'raw /condition = {}'].join('\n')), [
    {
      line: 6,
      column: 5,
      message: 'condition is given twice: by this raw line and by the match section on line 3',
    },
  ]);
});
