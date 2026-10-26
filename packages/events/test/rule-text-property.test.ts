import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type JsonObject, type JsonValue, parseRuleText, printRuleText } from '../src/index.ts';

/**
 * A property test of the rule text (0.33.0 design §3.2) over generated rule documents, with a fixed seed and no new
 * dependency. Readable documents are built from the condition AST, the source options, the agentic judge block, the
 * mapping template, the five target kinds and the retention fields; for each, printing then parsing gives the same
 * document, printing twice gives the same text, and no escape is needed. Odd documents — fields missing, extra or of
 * the wrong type — must still come back whole through the escape form.
 */

const SEED = 0x0330_e1;
const READABLE_CASES = 600;
const ODD_CASES = 300;
const DAY = 86_400_000;

/** mulberry32: a small, fixed, deterministic generator, so a failure names its case and can be replayed. */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (low: number, high: number) => low + Math.floor(next() * (high - low + 1));
  const pick = <T>(values: readonly T[]): T => values[int(0, values.length - 1)] as T;
  const chance = (probability: number) => next() < probability;
  const some = <T>(low: number, high: number, make: () => T): T[] => Array.from({ length: int(low, high) }, make);
  return { next, int, pick, chance, some };
}

type Random = ReturnType<typeof generator>;

/** Pieces of text that a printer could get wrong: quotes, escapes, markup, unicode, grammar words, punctuation. */
const PIECES = [
  'invoice',
  'Payment',
  '"quoted"',
  'back\\slash',
  'two\nlines',
  'tab\there',
  '\r',
  '<script>alert(1)</script>',
  'café',
  '🛰',
  '請求書',
  'שלום',
  '\ud800',
  String.fromCharCode(0x2028),
  ' ',
  '',
  'and',
  'version',
  'raw',
  'not',
  'any',
  'all',
  'port',
  'URL',
  'secret',
  'for',
  'nothing',
  'true',
  'null',
  '42',
  '-1',
  ',',
  '=',
  '#',
  '{',
  ']',
  '~',
  '/',
  '.',
  'a.b',
];

function text(random: Random): string {
  return random.some(0, 3, () => random.pick(PIECES)).join(random.pick(['', ' ', '-', '_']));
}

const WORD_PARTS = [
  'cue',
  'gmail',
  'rgc',
  'acme',
  'ibx_ABCDEFGH',
  'C00000001',
  'billing',
  'Label_1',
  '127.0.0.1',
  '::1',
];

/** A name the text writes bare, or any text, which it quotes. */
function name(random: Random): string {
  return random.chance(0.6)
    ? random.some(1, 2, () => random.pick(WORD_PARTS)).join(random.pick(['/', '-', '.', '@']))
    : text(random);
}

const TOKENS = [
  'subject',
  'from',
  'address',
  'name',
  'to',
  '0',
  'body',
  'snippet',
  'labelIds',
  'any',
  'for',
  'a-b',
  'x y',
  'a/b',
  'a~b',
  '',
];

/** A JSON Pointer: the empty one, or tokens escaped as RFC 6901 says. */
function pointer(random: Random): string {
  if (random.chance(0.05)) return '';
  return random
    .some(1, 3, () => random.pick(TOKENS))
    .map((token) => `/${token.replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('');
}

function number(random: Random): number {
  const magnitude = random.pick([0, 1, 7, 60, 1.5, 0.7, 1e21, 1e-7, 123_456.789, 2 ** 53 - 1]);
  return magnitude === 0 || random.chance(0.7) ? magnitude : -magnitude;
}

function scalar(random: Random): string | number | boolean | null {
  return random.pick([() => text(random), () => number(random), () => random.chance(0.5), () => null])();
}

function count(random: Random): number {
  return random.pick([0, 1, 2, 7, 60, 1000, 86_400_000, 604_800_000, 7_776_000_000, random.int(0, 1_000_000)]);
}

function condition(random: Random, depth: number): JsonObject {
  const shape = depth > 3 ? 'leaf' : random.pick(['leaf', 'leaf', 'leaf', 'any', 'all', 'not']);
  if (shape === 'any' || shape === 'all') return { [shape]: random.some(1, 4, () => condition(random, depth + 1)) };
  if (shape === 'not') return { not: condition(random, depth + 1) };
  const path = pointer(random);
  const op = random.pick([
    'exists',
    'equals',
    'notEquals',
    'contains',
    'startsWith',
    'endsWith',
    'in',
    'gt',
    'gte',
    'lt',
    'lte',
    'domainIs',
  ]);
  switch (op) {
    case 'exists':
      return { path, op };
    case 'equals':
    case 'notEquals':
    case 'contains':
      return { path, op, value: scalar(random), caseSensitive: random.chance(0.5) };
    case 'startsWith':
    case 'endsWith':
      return { path, op, value: text(random), caseSensitive: random.chance(0.5) };
    case 'in':
      return { path, op, values: random.some(1, 4, () => scalar(random)) };
    case 'domainIs':
      return {
        path,
        op,
        value: random.pick(['example.test', 'bücher.example', text(random)]),
        includeSubdomains: random.chance(0.5),
      };
    default:
      return {
        path,
        op,
        value: random.chance(0.5) ? number(random) : random.pick(['2026-10-26T00:00:00Z', text(random)]),
      };
  }
}

const CHANNEL_EVENTS: Readonly<Record<string, readonly string[]>> = {
  gmail: ['gmail.message.received', 'gmail.message.sent', 'gmail.message.labelled'],
  slack: ['slack.message.posted'],
  resend: ['resend.email.received', 'resend.email.status_changed'],
  whatsapp: ['whatsapp.message.received'],
};

function sourceAndEvent(random: Random): { source: JsonObject; event: JsonObject } {
  const channel = random.pick(Object.keys(CHANNEL_EVENTS));
  const names = () => random.some(1, 3, () => name(random));
  const options: Record<string, JsonValue> = { channel };
  if (channel === 'gmail') {
    options.labels = random.pick(['inbox', 'any', 'list']) === 'list' ? names() : random.pick(['inbox', 'any']);
    options.includeSpamTrash = random.chance(0.3);
  } else if (channel === 'slack') options.conversations = names();
  else if (channel === 'resend')
    options.kinds = random.pick([['received'], ['status'], ['received', 'status'], names()]);
  else options.chats = random.chance(0.4) ? 'all-allowed' : names();
  const type = random.chance(0.85)
    ? random.pick(CHANNEL_EVENTS[channel] as readonly string[])
    : `${channel}.${random.pick(['message.future', text(random)])}`;
  return {
    source: { channel, accountIds: names(), options },
    event: { type, version: random.chance(0.85) ? 1 : random.int(0, 9) },
  };
}

function judge(random: Random): JsonObject {
  const identity = { judgeId: name(random), version: random.int(0, 9) };
  switch (random.pick(['typesafe', 'local', 'laya', 'partial'])) {
    case 'typesafe':
      return {
        ...identity,
        kind: 'typesafe',
        provider: 'typesafe',
        model: 'jev-1.13.0',
        endpoint: 'https://api.typesafe.ai/v1/systemone',
        promptTemplate: 'typesafe-jev-noul-v1',
        protocol: 'noul',
      };
    case 'local':
      return {
        ...identity,
        kind: 'local-endpoint',
        provider: name(random),
        model: name(random),
        endpoint: random.pick(['http://127.0.0.1:11434/api/generate', `http://[::1]:8080/${text(random)}`]),
        approvedAddressSet: random.some(1, 2, () => random.pick(['127.0.0.1', '::1'])),
        promptTemplate: name(random),
        ...(random.chance(0.5) ? { protocol: 'json-score', scorePointer: pointer(random) } : { protocol: 'noul' }),
      };
    case 'laya':
      return { ...identity, kind: 'laya', provider: 'laya', model: name(random), promptTemplate: name(random) };
    default: {
      const partial: Record<string, JsonValue> = { ...identity };
      for (const field of ['kind', 'provider', 'model', 'endpoint', 'promptTemplate', 'protocol'])
        if (random.chance(0.4)) partial[field] = name(random);
      if (random.chance(0.3)) partial.approvedAddressSet = random.some(1, 3, () => name(random));
      if (random.chance(0.3)) partial.scorePointer = pointer(random);
      return partial;
    }
  }
}

function agentic(random: Random): JsonObject {
  const found: Record<string, JsonValue> = { judge: judge(random) };
  const optional: readonly (readonly [string, () => JsonValue])[] = [
    ['question', () => text(random)],
    ['inputs', () => random.some(0, 3, () => pointer(random))],
    ['threshold', () => random.pick([0, 0.5, 0.7, 1, random.next()])],
    ['onUncertain', () => random.pick(['no-match', 'hold'])],
    ['callsPerRollingHour', () => count(random)],
    ['inputTokensPerRolling30Days', () => count(random)],
    ['concurrency', () => count(random)],
    ['maxInputTokens', () => count(random)],
    ['maxOutputTokens', () => count(random)],
  ];
  for (const [field, make] of optional) if (random.chance(0.85)) found[field] = make();
  return found;
}

const KEYS = [
  'subject',
  'from',
  'address',
  'sender',
  'channel',
  'id',
  'kind',
  'odd key',
  'a.b',
  '"',
  'for',
  'nothing',
  '',
];

function template(random: Random, depth: number): JsonObject {
  const found: Record<string, JsonValue> = {};
  for (const key of random.some(depth === 0 ? 0 : 1, 4, () => random.pick(KEYS))) {
    const kind = depth > 2 ? 'reference' : random.pick(['reference', 'reference', 'container', 'constant']);
    if (kind === 'reference')
      found[key] = random.chance(0.3)
        ? { $path: pointer(random), missing: random.pick(['reject', 'null', 'omit', name(random)]) }
        : { $path: pointer(random) };
    else if (kind === 'container') found[key] = template(random, depth + 1);
    else
      found[key] = random.pick([
        () => scalar(random),
        () => ({}),
        () => [],
        () => [scalar(random), { $path: pointer(random) }],
        () => ({ $path: 7 }),
      ])();
  }
  return found;
}

function target(random: Random, index: number): JsonObject {
  const identity = { targetId: `${name(random)}${index}`, version: random.int(0, 9) };
  const kind = random.pick(['dry-run', 'queue', 'webhook', 'sse', 'linear']);
  if (kind === 'dry-run') return { ...identity, kind, ...(random.chance(0.8) ? { retentionMs: count(random) } : {}) };
  if (kind === 'queue')
    return {
      ...identity,
      kind,
      retentionMs: count(random),
      show: random.pick(['summary', 'minimal', name(random)]),
      ...(random.chance(0.5) ? { lane: { name: name(random) } } : {}),
    };
  if (kind === 'linear') return linear(random, identity);
  if (kind === 'webhook') {
    const optional: Record<string, JsonValue> = {};
    if (random.chance(0.9))
      optional.url = random.chance(0.5)
        ? {
            kind: 'plain',
            value: random.pick(['https://hooks.example.test:443/in', `http://127.0.0.1:9/${text(random)}`]),
          }
        : {
            kind: 'secret',
            scheme: random.pick(['https', 'http']),
            host: name(random),
            port: count(random),
            sha256: 'f'.repeat(64),
          };
    if (random.chance(0.9)) optional.approvedAddressSet = random.some(1, 3, () => name(random));
    if (random.chance(0.9)) optional.retryLimit = random.int(0, 20);
    if (random.chance(0.9)) optional.representation = random.pick(['plain', 'enveloped']);
    return {
      ...identity,
      kind,
      signing: random.chance(0.8) ? 'standard-webhooks' : name(random),
      ordering: random.chance(0.8) ? 'strict' : name(random),
      ...optional,
    };
  }
  return {
    ...identity,
    kind,
    ...(random.chance(0.8) ? { subscriberId: name(random), subscriberVersion: random.int(0, 9) } : {}),
    ...(random.chance(0.8) ? { representation: random.pick(['plain', 'enveloped']) } : {}),
  };
}

/**
 * A Linear issue target (0.33.0 design §3.4): a team by key, id or both, labels all with ids or all by name alone, an
 * assignee, and title and description templates whose text is anything at all.
 */
function linear(random: Random, identity: { targetId: string; version: number }): JsonObject {
  const team: Record<string, JsonValue> = {};
  const shape = random.int(0, 3);
  if (shape !== 1) team.key = random.pick(['CUE', 'RGC', name(random)]);
  if (shape !== 2) team.id = random.pick(['0b6a6f0e-8a8e-4c55-9d7c-6a1c0f8b8c11', name(random)]);
  const withIds = random.chance(0.7);
  const labels = random
    .some(0, 3, () => name(random))
    .map((label) => (withIds ? { id: name(random), name: label } : { name: label }));
  const template = () => ({
    text: random.pick(['Invoice from {{from.address}}', '{{subject}}\n\nCheck it.', text(random), '']),
  });
  return {
    ...identity,
    kind: 'linear',
    ...(shape === 3 ? {} : { team }),
    ...(random.chance(0.9) ? { title: template() } : {}),
    ...(random.chance(0.9) ? { description: template() } : {}),
    labels,
    assignee: random.pick(['me', null, { id: name(random) }]),
  };
}

function subscriber(random: Random): JsonObject {
  return {
    subscriberId: name(random),
    version: random.int(0, 9),
    kind: 'sse',
    ...(random.chance(0.8)
      ? { authority: { host: random.pick(['127.0.0.1', '::1']), port: random.int(1, 65_535) } }
      : {}),
    ...(random.chance(0.8)
      ? {
          origins: random.some(1, 3, () =>
            random.pick(['http://127.0.0.1:5173', 'http://localhost:5173', text(random)]),
          ),
        }
      : {}),
    ...(random.chance(0.8) ? { retentionMs: count(random) } : {}),
  };
}

const RETENTION_FIELDS = [
  'ingestMs',
  'holdMs',
  'deliveryMs',
  'dryrunMs',
  'sseReplayMs',
  'deadLetterMs',
  'decisionMetadataMs',
];
const DEFAULTS: Readonly<Record<string, number>> = {
  ingestMs: 7 * DAY,
  holdMs: 7 * DAY,
  deliveryMs: 7 * DAY,
  dryrunMs: DAY,
  sseReplayMs: 7 * DAY,
  deadLetterMs: 7 * DAY,
  decisionMetadataMs: 90 * DAY,
};

/** A readable rule document: every part has words in the rule text. */
function readable(random: Random): JsonObject {
  const targets = random.some(1, 4, () => undefined).map((_, index) => target(random, index));
  const queued = targets.some((entry) => entry.kind === 'queue');
  const retention: Record<string, JsonValue> = {};
  for (const field of RETENTION_FIELDS)
    retention[field] = random.chance(0.5) ? (DEFAULTS[field] as number) : count(random);
  if (queued || random.chance(0.2)) retention.queueMs = random.chance(0.5) ? 7 * DAY : count(random);
  return {
    ruleId: name(random),
    version: random.int(0, 99),
    ...sourceAndEvent(random),
    condition: condition(random, 0),
    ...(random.chance(0.5) ? { agentic: agentic(random) } : {}),
    mapping: template(random, 0),
    ...(random.chance(0.3) ? { cloudEventType: random.pick(['com.example.invoice', text(random)]) } : {}),
    targets,
    subscribers: random.some(0, 2, () => subscriber(random)),
    judges: [],
    deliveryRateCap: count(random),
    retention,
  };
}

/** An odd document: a readable one with fields missing, extra, or of a type the readable form has no words for. */
function odd(random: Random): JsonObject {
  const doc = JSON.parse(JSON.stringify(readable(random))) as Record<string, JsonValue>;
  const mutations: readonly (() => void)[] = [
    () => {
      // defineProperty, so `__proto__` is a field like any other rather than the prototype.
      Object.defineProperty(doc, random.pick(['extra', '__proto__', 'a/b', 'note']), {
        value: random.pick([text(random), { nested: [1, null] }]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    },
    () => {
      delete doc[
        random.pick([
          'ruleId',
          'version',
          'source',
          'event',
          'condition',
          'targets',
          'judges',
          'subscribers',
          'retention',
        ])
      ];
    },
    () => {
      doc.condition = random.pick([{}, { path: '/subject', op: 'contains', value: 'x' }, { any: [] }, { not: 'x' }]);
    },
    () => {
      doc.targets = random.pick([
        [],
        [{ targetId: 'later', version: 1, kind: 'linear', team: { id: 't', key: 'CUE' } }],
        'none',
      ]);
    },
    () => {
      doc.agentic = random.pick([
        { question: 'no judge' },
        { judge: { judgeId: 'j', version: 1, extra: true } },
        'yes',
      ]);
    },
    () => {
      doc.mapping = random.pick([{ $path: '/subject' }, 'all', ['/subject'], null]);
    },
    () => {
      doc.retention = random.pick([{ sseReplayMs: 500 }, { ...DEFAULTS, ingestMs: -1 }, { ...DEFAULTS, extra: 1 }]);
    },
    () => {
      doc.event = random.pick([
        { version: 1 },
        { type: 7, version: 1 },
        { type: 'gmail.message.received', version: -1 },
      ]);
    },
    () => {
      doc.source = random.pick([{ channel: 'gmail', accountIds: [], options: {} }, { channel: 'fax' }, 'gmail']);
    },
    () => {
      doc.judges = [{ judgeId: 'legacy', version: 1 }];
    },
    () => {
      doc.subscribers = [{ subscriberId: 's', version: 1, kind: 'websocket' }];
    },
    () => {
      doc.deliveryRateCap = random.pick([1.5, -1, '60']);
    },
  ];
  for (let index = random.int(1, 3); index > 0; index -= 1) random.pick(mutations)();
  return doc as JsonObject;
}

/** Whether a printed rule uses the escape form anywhere. */
const escaped = (text: string) => text.split('\n').some((line) => /^\s*(match )?(not )*raw\b/.test(line));

function check(doc: JsonObject, label: string): string {
  const text = printRuleText(doc);
  const parsed = parseRuleText(text);
  assert.ok(parsed.ok, `${label}: the printed text parses\n${text}\n${JSON.stringify(parsed)}`);
  assert.deepStrictEqual(parsed.doc, doc, `${label}: the document round-trips through\n${text}`);
  assert.equal(printRuleText(parsed.doc), text, `${label}: printing is stable`);
  return text;
}

test(`${READABLE_CASES} generated readable rules round-trip, print stably, and need no escape`, () => {
  const random = generator(SEED);
  for (let index = 0; index < READABLE_CASES; index += 1) {
    const doc = readable(random);
    const text = check(doc, `readable case ${index} (seed ${SEED})`);
    assert.equal(escaped(text), false, `readable case ${index} needs no escape:\n${text}`);
  }
});

test(`${ODD_CASES} generated odd rules still come back whole, through the escape form`, () => {
  const random = generator(SEED + 1);
  let escapedCases = 0;
  for (let index = 0; index < ODD_CASES; index += 1) {
    const doc = odd(random);
    if (escaped(check(doc, `odd case ${index} (seed ${SEED + 1})`))) escapedCases += 1;
  }
  assert.ok(escapedCases > ODD_CASES / 2, `most odd cases use the escape form (${escapedCases})`);
});
