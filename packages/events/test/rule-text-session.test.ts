import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type JsonObject, parseRuleText, printRuleText, RULE_RETENTION_DEFAULTS, targetQueues } from '../src/index.ts';

/**
 * The agent-session target in the rule text (0.33.0 design §3.5–§3.6, GRAMMAR.md "then"): `session … working in
 * <folder>` or `in lane <name>`, `if none start with claude-code`, `if busy wait`, and `give` with its context parts.
 */

const DAY = 86_400_000;
const { queueMs, ...DEFAULT_RETENTION } = RULE_RETENTION_DEFAULTS;

function rule(targets: readonly JsonObject[], queued = false): JsonObject {
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
    mapping: { from: { address: { $path: '/from/address' } }, subject: { $path: '/subject' } },
    targets: targets as JsonObject[],
    subscribers: [],
    judges: [],
    deliveryRateCap: 60,
    retention: queued ? { ...DEFAULT_RETENTION, queueMs } : DEFAULT_RETENTION,
  } as JsonObject;
}

function roundTrip(doc: JsonObject): string {
  const text = printRuleText(doc);
  const parsed = parseRuleText(text);
  assert.ok(parsed.ok, `the printed text parses:\n${text}\n${JSON.stringify(parsed)}`);
  assert.deepStrictEqual(parsed.doc, doc, `the document round-trips through:\n${text}`);
  assert.equal(printRuleText(parsed.doc), text, 'printing is stable');
  return text;
}

function thenSection(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf('then');
  const out: string[] = [];
  for (const line of lines.slice(start)) {
    if (out.length > 0 && !line.startsWith('  ') && line !== '') break;
    out.push(line);
  }
  while (out.at(-1) === '') out.pop();
  return out;
}

const SESSION: JsonObject = {
  targetId: 'acme-session',
  version: 1,
  kind: 'session',
  find: { folder: '/example/home/acme' },
  ifNone: 'start',
  provider: 'claude',
  mode: 'manual',
  ifBusy: 'queue',
  context: [
    { fields: ['/from/address', '/subject'] },
    { text: 'Check the invoice against Stripe before replying. Never pay anything.' },
    {
      generate: {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4.5',
        instruction: 'Say in one line what the sender wants, and by when.',
        from: ['/subject'],
      },
    },
    { file: '/example/home/acme/billing/HOW-WE-INVOICE.md' },
  ],
  instruction: 'Reply to the sender with what you found.',
};

test("session: the prototype's session prints as the prototype draws it, and round-trips", () => {
  const text = roundTrip(rule([SESSION]));
  assert.deepEqual(thenSection(text), [
    'then',
    '  session acme-session, version 1, working in /example/home/acme',
    '    if none start with claude-code',
    '    if busy wait',
    '    give',
    '      fields from.address, subject',
    '      text "Check the invoice against Stripe before replying. Never pay anything."',
    '      written by anthropic/claude-sonnet-4.5 via openrouter, asking "Say in one line what the sender wants, and by when.", from subject',
    '      file /example/home/acme/billing/HOW-WE-INVOICE.md',
    '    instruction "Reply to the sender with what you found."',
  ]);
});

test('session: a lane, codex, leaving it in the queue, another mode, and no context', () => {
  const lane: JsonObject = {
    targetId: 'david',
    version: 2,
    kind: 'session',
    find: { lane: 'david' },
    ifNone: 'queue-only',
    provider: 'codex',
    mode: 'plan',
    ifBusy: 'queue-only',
    context: [],
  };
  const folder: JsonObject = {
    ...lane,
    targetId: 'quiet',
    find: { folder: '/example/home/with space' },
    provider: 'claude',
    mode: 'manual',
    ifBusy: 'queue',
  };
  const text = roundTrip(rule([lane, folder], true));
  assert.deepEqual(thenSection(text), [
    'then',
    '  session david, version 2, in lane david, with codex',
    '    if busy leave it in the queue',
    '    mode plan',
    '',
    '  session quiet, version 2, working in "/example/home/with space", with claude-code',
    '    if none leave it in the queue',
    '    if busy wait',
  ]);
  assert.doesNotMatch(text, /keep for/u, 'a session that queues has the queue retention, 7 days, unless said');
});

test('session: which session targets put an item in the Queue, so the rule keeps queue items', () => {
  assert.ok(!targetQueues(SESSION));
  assert.ok(targetQueues({ ...SESSION, find: { lane: 'billing' } }), 'a lane window’s items are lane queue items');
  assert.ok(targetQueues({ ...SESSION, ifNone: 'queue-only' }));
  assert.ok(targetQueues({ ...SESSION, ifBusy: 'queue-only' }));
  assert.ok(targetQueues({ targetId: 'q', version: 1, kind: 'queue' }));
  assert.ok(!targetQueues({ targetId: 'd', version: 1, kind: 'dry-run' }));
  const parsed = parseRuleText(
    printRuleText(rule([{ ...SESSION, ifBusy: 'queue-only' }], true)).replace(/^keep for[\s\S]*$/mu, ''),
  );
  assert.ok(parsed.ok);
  assert.equal((parsed.doc.retention as JsonObject).queueMs, 7 * DAY, 'the parser fills the queue retention');
});

test('session: what the text leaves out, the parser fills — leave it in the queue, wait, manual, no context', () => {
  const parsed = parseRuleText(
    [
      'rule r, version 1',
      'when a new message arrives in cue/gmail, in the inbox',
      'match subject exists',
      'then',
      '  session s, version 1, working in /example/home/acme, with claude-code',
    ].join('\n'),
  );
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepEqual((parsed.doc.targets as JsonObject[])[0], {
    targetId: 's',
    version: 1,
    kind: 'session',
    find: { folder: '/example/home/acme' },
    ifNone: 'queue-only',
    provider: 'claude',
    mode: 'manual',
    ifBusy: 'queue',
    context: [],
  });
});

test('session: a part or a shape the readable form cannot say is raw, so nothing is dropped', () => {
  const oddPart = { ...SESSION, context: [{ text: 'fine' }, { prompt: 'unknown' }] };
  const text = roundTrip(rule([oddPart]));
  assert.match(text, /^ {6}raw \{"prompt":"unknown"\}$/mu);
  const oddProvider = { ...SESSION, provider: 'gemini' };
  assert.match(roundTrip(rule([oddProvider])), /^ {2}raw \{.*"kind":"session".*\}$/mu);
  const both = { ...SESSION, find: { folder: '/x', lane: 'y' } };
  assert.match(roundTrip(rule([both])), /^ {2}raw /mu);
});

function errorsOf(lines: readonly string[]) {
  const parsed = parseRuleText(
    [
      'rule r, version 1',
      'when a new message arrives in cue/gmail, in the inbox',
      'match subject exists',
      'then',
      ...lines,
    ].join('\n'),
  );
  assert.equal(parsed.ok, false);
  return parsed.ok ? [] : parsed.errors.map((error) => error.message);
}

test('session: mistakes are named where they stand', () => {
  assert.deepEqual(errorsOf(['  session s, version 1, working in /a, in lane b, with codex']), [
    'a session is found by its folder or by a lane, not both',
  ]);
  assert.deepEqual(errorsOf(['  session s, version 1, working in /a, with gpt']), [
    'a session\'s provider is claude-code or codex; found "gpt"',
  ]);
  assert.deepEqual(
    errorsOf(['  session s, version 1, working in /a, with codex', '    if none start with claude-code']),
    ['a session names its provider once'],
  );
  assert.deepEqual(errorsOf(['  session s, version 1, working in /a']), [
    'a session names its provider: "if none start with claude-code", or ", with claude-code" after its folder',
  ]);
  assert.deepEqual(errorsOf(['  session s, version 1, working in /a, with codex', '    if busy hurry']), [
    'if busy says wait or leave it in the queue; found "hurry"',
  ]);
  assert.deepEqual(errorsOf(['  session s, version 1, working in /a, with codex', '    give']), [
    'give needs its context parts on the lines indented under it',
  ]);
  assert.deepEqual(errorsOf(['  session s, version 1, working in /a, with codex', '    give', '      prompt "x"']), [
    'a context part is fields, text, written by, file or raw; found "prompt"',
  ]);
  assert.deepEqual(
    errorsOf(['  session s, version 1, working in /a, with codex', '    give', '      written by m via openrouter']),
    ['expected ", asking "<instruction>"" after the provider, found the end of the line'],
  );
  assert.deepEqual(
    errorsOf(['  session s, version 1, working in /a, with codex', '    if busy wait', '    if busy wait']),
    ['a session says if busy once; it is already on line 6'],
  );
});
