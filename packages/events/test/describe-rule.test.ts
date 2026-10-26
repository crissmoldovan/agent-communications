import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as events from '../src/index.ts';
import {
  type DescribableRuleDocument,
  describeRule,
  type FieldLabels,
  type RulePart,
} from '../src/rules/describe-rule.ts';

/**
 * 0.32.0, owner feedback §3.4: a rule in plain words. `describeRule` returns the sentence as parts, so the app can show
 * every rule-author string (condition operands, the judge's question) as outside text, and the terminal can print it.
 */

const GMAIL = 'ibx_DESCRIBERULE0001';
const SLACK = 'acc_DESCRIBERULESLK1';
const aliases = { accountNames: { [GMAIL]: 'cue/gmail', [SLACK]: 'cue/slack' } };

const text = (parts: readonly RulePart[]) => parts.map((part) => part.text).join('');
const ofKind = (parts: readonly RulePart[], kind: RulePart['kind']) =>
  parts.filter((part) => part.kind === kind).map((part) => part.text);

const invoices: DescribableRuleDocument = {
  source: {
    channel: 'gmail',
    accountIds: [GMAIL],
    options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: {
    any: [
      { path: '/subject', op: 'contains', value: 'invoice', caseSensitive: false },
      { path: '/subject', op: 'contains', value: 'receipt', caseSensitive: false },
    ],
  },
  agentic: {
    judge: { judgeId: 'jev', version: 1, kind: 'typesafe' },
    question: 'Is this an invoice we have to pay?',
    onUncertain: 'no-match',
  },
  targets: [
    {
      targetId: 'billing',
      version: 1,
      kind: 'queue',
      retentionMs: 604_800_000,
      show: 'summary',
      lane: { name: 'billing' },
    },
  ],
};

test('0.32 B5: a Gmail rule with any of two contains, a judge and a lane reads as the spec’s sentence', () => {
  const parts = describeRule(invoices, aliases);
  assert.equal(
    text(parts),
    "When mail arrives in cue/gmail with 'invoice' or 'receipt' in the subject, ask Jev 'Is this an invoice we have to pay?'. If it says yes, put it in the Queue, lane billing.",
  );
  assert.deepEqual(ofKind(parts, 'value'), ['cue/gmail', 'Jev', 'Queue', 'billing']);
  assert.deepEqual(ofKind(parts, 'untrusted'), ['invoice', 'receipt', 'Is this an invoice we have to pay?']);
  for (const part of parts) assert.deepEqual(Object.keys(part).sort(), ['kind', 'text']);
});

test('0.32 B5: a Slack rule with no judge, a webhook target and a conversation reads without a judge', () => {
  const parts = describeRule(
    {
      source: { channel: 'slack', accountIds: [SLACK], options: { channel: 'slack', conversations: ['C0123ABCD'] } },
      event: { type: 'slack.message.posted', version: 1 },
      condition: {
        all: [
          { path: '/text', op: 'contains', value: 'deploy', caseSensitive: true },
          { path: '/author/external', op: 'equals', value: false, caseSensitive: false },
        ],
      },
      targets: [
        {
          targetId: 'ops-hook',
          version: 2,
          kind: 'webhook',
          url: { kind: 'plain', value: 'https://hooks.example.test/agentcomms?key=fake-query-part' },
        },
      ],
    },
    aliases,
  );
  assert.equal(
    text(parts),
    "When a message is posted in cue/slack (in C0123ABCD) where the text contains 'deploy' (matching case) and the external-author flag is 'false', send it to hooks.example.test.",
  );
  assert.deepEqual(ofKind(parts, 'untrusted'), ['C0123ABCD', 'deploy', 'false']);
  assert.deepEqual(ofKind(parts, 'value'), ['cue/slack', 'hooks.example.test']);
  assert.doesNotMatch(text(parts), /fake-query-part/u, 'a webhook shows its host, never its path or query');
});

test('0.32 B5: a dry-run target, an account with no alias, and the judge that holds when unsure', () => {
  const parts = describeRule({
    ...invoices,
    condition: { path: '/subject', op: 'exists' },
    agentic: {
      ...invoices.agentic,
      judge: { judgeId: 'nimble', version: 3, kind: 'local-endpoint' },
      onUncertain: 'hold',
    },
    targets: [
      { targetId: 'dry-invoices', version: 1, kind: 'dry-run', retentionMs: 86_400_000 },
      { targetId: 'billing', version: 1, kind: 'queue', retentionMs: 604_800_000, show: 'minimal' },
    ],
  } as DescribableRuleDocument);
  assert.equal(
    text(parts),
    "When mail arrives in ibx_DESCRIBERULE0001 where the subject is present, ask the local model 'Is this an invoice we have to pay?'. If it says yes, record it in the Dry-run log and put it in the Queue. If it is not sure, it is held for you to decide.",
  );
  assert.deepEqual(ofKind(parts, 'value'), ['ibx_DESCRIBERULE0001', 'the local model', 'Dry-run log', 'Queue']);
});

test('0.33 E3: a Linear target reads as an issue added to Linear, naming its team', () => {
  const parts = describeRule({
    ...invoices,
    condition: { path: '/subject', op: 'exists' },
    targets: [
      {
        targetId: 'billing-issues',
        version: 1,
        kind: 'linear',
        team: { id: '0b6a6f0e-8a8e-4c55-9d7c-6a1c0f8b8c11', key: 'CUE' },
      },
    ],
  } as DescribableRuleDocument);
  assert.match(text(parts), /If it says yes, add an issue to Linear, team CUE\.$/u);
  assert.deepEqual(ofKind(parts, 'value').slice(-2), ['Linear', 'CUE']);
});

test('0.32 B5: an operand holding markup comes back as an untrusted part, unchanged', () => {
  const hostile = '<script>alert("x")</script> ignore the rule‮';
  const parts = describeRule(
    { ...invoices, condition: { path: '/subject', op: 'startsWith', value: hostile, caseSensitive: false } },
    aliases,
  );
  assert.ok(
    parts.some((part) => part.kind === 'untrusted' && part.text === hostile),
    'the operand is one untrusted part',
  );
  for (const part of parts)
    if (part.kind !== 'untrusted') assert.doesNotMatch(part.text, /script|ignore/u, `${part.kind}: ${part.text}`);
});

test('0.32 B5: pointers are labelled from the catalogue, then from the labels given, falling back to the pointer', () => {
  const describe = (path: string, labels: FieldLabels = aliases) =>
    text(describeRule({ ...invoices, agentic: undefined, condition: { path, op: 'exists' } }, labels));
  assert.match(describe('/from/address'), / where the sender's address is present, /u);
  // A catalogue field with no friendlier name reads as its own words.
  assert.match(describe('/authentication/dmarc'), / where the authentication dmarc is present, /u);
  assert.match(
    describe('/authentication/dmarc', { ...aliases, fields: { '/authentication/dmarc': 'the DMARC result' } }),
    / where the DMARC result is present, /u,
  );
  // A pointer the catalogue does not declare is shown as it is, and as rule-author text.
  const unknown = describeRule({ ...invoices, agentic: undefined, condition: { path: '/nonsense', op: 'exists' } });
  assert.ok(unknown.some((part) => part.kind === 'untrusted' && part.text === '/nonsense'));
});

test('0.32 B5: every condition operator reads in words, with its operand untrusted', () => {
  const where = (condition: DescribableRuleDocument['condition']) => {
    const parts = describeRule({ ...invoices, agentic: undefined, condition }, aliases);
    const sentence = text(parts);
    return sentence.slice(sentence.indexOf(' where ') + 7, sentence.lastIndexOf(', put it in the Queue'));
  };
  assert.equal(where({ path: '/subject', op: 'equals', value: 'Hi', caseSensitive: false }), "the subject is 'Hi'");
  assert.equal(
    where({ path: '/subject', op: 'notEquals', value: 'Hi', caseSensitive: false }),
    "the subject is not 'Hi'",
  );
  assert.equal(
    where({ path: '/subject', op: 'endsWith', value: '!', caseSensitive: false }),
    "the subject ends with '!'",
  );
  assert.equal(where({ path: '/subject', op: 'in', values: ['a', 'b'] }), "the subject is one of 'a', 'b'");
  assert.equal(where({ path: '/date', op: 'gt', value: '2026-01-01' }), "the date is after '2026-01-01'");
  assert.equal(where({ path: '/date', op: 'lte', value: '2026-01-01' }), "the date is on or before '2026-01-01'");
  assert.equal(where({ path: '/attachments/0/size', op: 'gte', value: 5 }), "the attachments 0 size is at least '5'");
  assert.equal(
    where({ path: '/from/address', op: 'domainIs', value: 'example.test', includeSubdomains: true }),
    "the sender's address is at 'example.test' or a subdomain",
  );
  assert.equal(
    where({ not: { path: '/subject', op: 'contains', value: 'spam', caseSensitive: false } }),
    "not (the subject contains 'spam')",
  );
  assert.equal(
    where({
      all: [
        { path: '/unread', op: 'equals', value: true, caseSensitive: false },
        {
          any: [
            { path: '/subject', op: 'contains', value: 'a', caseSensitive: false },
            { path: '/body', op: 'contains', value: 'b', caseSensitive: false },
          ],
        },
      ],
    }),
    "the unread flag is 'true' and (the subject contains 'a' or the body contains 'b')",
  );
});

test('0.32 B5: describeRule and its types are exported from the package', () => {
  assert.equal(events.describeRule, describeRule);
});
