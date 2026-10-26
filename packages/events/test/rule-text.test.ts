import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATALOGUE, type JsonObject, parseRuleText, printRuleText } from '../src/index.ts';

/**
 * The rule text (0.33.0 design §3.2): `printRuleText` writes a rule document as the prototype's small language, and
 * `parseRuleText` reads it back to the same document. Each section has its examples here; every rule fixture in the
 * repository is in `rule-text-fixtures.test.ts`, and generated documents in `rule-text-property.test.ts`.
 */

const DAY = 86_400_000;

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
