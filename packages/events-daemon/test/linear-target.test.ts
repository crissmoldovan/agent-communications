import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogueEntry, compileMapping, describeRule, type JsonValue } from '@agentcomms/events';
import {
  type ActivationDocumentV1,
  canonicalFullRuleDocument,
  canonicalTarget,
} from '../src/domain/activation-documents.ts';
import { EventDomainError } from '../src/domain/lifecycle.ts';
import {
  canonicalLinearTarget,
  type LinearTargetDocument,
  linearIssueId,
  mappedFields,
  outsideBlock,
  renderLinearIssue,
} from '../src/domain/linear-target.ts';
import { renderB3ApprovalPreviewV1 } from '../src/operations/b3-contract.ts';

/*
 * The Linear target's document (0.33.0 design §3.4): its canonical form, the activation check that every slot names a
 * mapped field, the issue it renders — with what a sender wrote kept out of Linear's Markdown — and what the approval
 * preview says it does. Ids are made up; nothing here reaches Linear.
 */

const TEAM = '0b6a6f0e-8a8e-4c55-9d7c-6a1c0f8b8c11';
const BILLING = '3e1f8a52-7c1d-4a8e-9f00-2b6c1d4e5f60';
const URGENT = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const USER = '9c8b7a6d-5e4f-4321-8abc-def012345678';
const DAY = 86_400_000;

function linear(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetId: 'billing-issues',
    version: 1,
    kind: 'linear',
    team: { id: TEAM, key: 'CUE' },
    title: { text: 'Invoice from {{sender}}: {{subject}}' },
    description: { text: 'Check it against Stripe.\n\nSubject: {{subject}}\nKind: {{kind}}' },
    labels: [{ id: BILLING, name: 'Billing' }],
    assignee: 'me',
    ...overrides,
  };
}

function rule(target: Record<string, unknown>, mapping: JsonValue = defaultMapping()): Record<string, unknown> {
  return {
    ruleId: 'invoices',
    version: 4,
    source: {
      channel: 'gmail',
      accountIds: ['ibx_LINEARTARGET0001'],
      options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'contains', value: 'invoice', caseSensitive: false },
    mapping,
    targets: [target],
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
  };
}

function defaultMapping(): JsonValue {
  return { sender: { $path: '/from/address' }, subject: { $path: '/subject' }, kind: 'invoice' };
}

const refusedWith = (code: string, message?: RegExp) => (error: unknown) =>
  error instanceof EventDomainError && error.code === code && (message === undefined || message.test(error.message));

test('E3: a Linear target is canonical — exact keys, labels sorted by id, and no labels and nobody written out', () => {
  assert.deepEqual(
    canonicalTarget(
      linear({
        labels: [
          { id: BILLING, name: 'Billing' },
          { id: URGENT, name: 'Urgent' },
        ],
      }),
    ),
    {
      ...linear(),
      labels: [
        { id: URGENT, name: 'Urgent' },
        { id: BILLING, name: 'Billing' },
      ],
    },
  );
  const { labels: _labels, assignee: _assignee, ...bare } = linear();
  assert.deepEqual(canonicalLinearTarget(bare), { ...linear(), labels: [], assignee: null });
  assert.deepEqual(canonicalLinearTarget(linear({ assignee: { id: USER } })).assignee, { id: USER });
  for (const [what, overrides] of [
    ['an extra field', { project: 'x' }],
    ['a team without its id', { team: { key: 'CUE' } }],
    ['a team id that is not a Linear id', { team: { id: 'team-1', key: 'CUE' } }],
    ['a team key with a space', { team: { id: TEAM, key: 'C U E' } }],
    ['an empty title', { title: { text: '  ' } }],
    ['a title on two lines', { title: { text: 'one\ntwo' } }],
    ['a title too long', { title: { text: 'x'.repeat(256) } }],
    ['a description too long', { description: { text: 'x'.repeat(10_001) } }],
    ['a template as a bare string', { title: 'Invoice' }],
    ['a malformed slot', { title: { text: 'Invoice {{ from address }}' } }],
    ['an unclosed slot', { description: { text: 'From {{sender' } }],
    ['a control character', { description: { text: 'bell\u0007' } }],
    [
      'the same label twice',
      {
        labels: [
          { id: BILLING, name: 'Billing' },
          { id: BILLING, name: 'Billing' },
        ],
      },
    ],
    ['a label without a name', { labels: [{ id: BILLING }] }],
    ['an assignee by name', { assignee: 'criss' }],
    ['21 labels', { labels: Array.from({ length: 21 }, () => ({ id: BILLING, name: 'Billing' })) }],
  ] as const)
    assert.throws(() => canonicalTarget(linear(overrides)), refusedWith('VERSION_DOCUMENT_INVALID'), what);
});

test('E3: a model-written title or description is refused, not yet: it arrives with the session target’s context', () => {
  for (const part of ['title', 'description'])
    assert.throws(
      () =>
        canonicalTarget(
          linear({ [part]: { generate: { provider: 'openrouter', instruction: 'Summarise', from: ['/subject'] } } }),
        ),
      refusedWith('TEMPLATE_GENERATE_NOT_YET', /arrives with the session target's context/u),
      part,
    );
});

test('E3: activation refuses a slot that names a field the rule does not map, naming the fields it does keep', () => {
  assert.equal(canonicalFullRuleDocument(rule(linear())).targets[0]?.kind, 'linear');
  assert.throws(
    () => canonicalFullRuleDocument(rule(linear({ title: { text: 'From {{from.name}}' } }))),
    refusedWith('TEMPLATE_FIELD_NOT_MAPPED', /names \{\{from\.name\}\}.*keeps kind, sender, subject/u),
  );
  assert.throws(
    () => canonicalFullRuleDocument(rule(linear({ description: { text: '{{body}}' } }))),
    refusedWith('TEMPLATE_FIELD_NOT_MAPPED', /description names \{\{body\}\}/u),
  );
  // A field kept where it is, `from.address`, is named by its dotted path.
  assert.doesNotThrow(() =>
    canonicalFullRuleDocument(
      rule(linear({ title: { text: '{{from.address}}' }, description: { text: '' } }), {
        from: { address: { $path: '/from/address' } },
      }),
    ),
  );
});

function rendered(target: LinearTargetDocument, data: JsonValue) {
  const definition = catalogueEntry('gmail.message.received', 1);
  assert.ok(definition.ok);
  const compiled = compileMapping(definition.value, defaultMapping());
  assert.ok(compiled.ok);
  return renderLinearIssue({
    target,
    ruleId: 'invoices',
    ruleVersion: 4,
    deliveryId: 'dl-1',
    data,
    fields: mappedFields(compiled.value),
  });
}

test('E3: what a sender wrote reaches Linear as text only — no link, mention, image or markup — and quoted as from outside', () => {
  const hostile = [
    'Pay now https://evil.example/pay and see https://linear.app/acme/profiles/ceo',
    '@ceo please [click](https://evil.example) ![x](https://evil.example/x.png) CUE-12 <b>bold</b>',
    '```',
    '> not a quote',
    '\u202eevil\u0007',
  ].join('\n');
  const issue = rendered(canonicalLinearTarget(linear()), {
    sender: 'Mallory <mallory@evil.example>\nSecond line',
    subject: hostile,
    kind: 'invoice',
  });
  // The title is one line of plain text, its control characters gone.
  assert.equal(issue.title.includes('\n'), false);
  assert.match(issue.title, /^Invoice from Mallory <mallory@evil\.example> Second line: Pay now /u);
  assert.equal(issue.title.includes('\u0007') || issue.title.includes('\u202e'), false);
  assert.ok(issue.title.length <= 255, 'the title fits Linear’s');

  // The person's own words come through as written; the constant the rule maps is theirs too.
  assert.match(issue.description, /^Check it against Stripe\.\n\nSubject: /u);
  assert.match(
    issue.description,
    /Kind: invoice\n\n_Added by Agent Comms: rule invoices, version 4; delivery dl\\-1\._$/u,
  );
  // Every line of the sender's text is inside one quoted, fenced block, whose fence outruns their backticks.
  const block = outsideBlock('subject', hostile);
  assert.ok(issue.description.includes(block));
  const lines = block.split('\n');
  assert.equal(lines[0], '> **From outside: written by the sender, not checked** (`subject`)');
  assert.equal(lines[2], '> ````text', 'a fence longer than the three backticks the sender wrote');
  assert.equal(lines.at(-1), '> ````');
  for (const line of lines) assert.match(line, /^>( |$)/u, `every line is quoted: ${line}`);
  const inside = lines.slice(3, -1).join('\n');
  assert.ok(inside.includes('https://linear.app/acme/profiles/ceo'), 'shown as text, inside the code block');
  assert.ok(inside.includes('> > not a quote'), 'a quote the sender wrote stays inside the block');
  assert.equal(
    issue.description.includes('\u0007') || issue.description.includes('\u202e'),
    false,
    'no control or direction character',
  );
  // Outside the fenced blocks, nothing the sender wrote appears at all.
  const outside = issue.description
    .split('\n')
    .filter((line) => !line.startsWith('>'))
    .join('\n');
  for (const word of ['evil.example', 'mallory', '@ceo', 'CUE-12', '<b>', 'profiles'])
    assert.equal(outside.includes(word), false, `${word} only inside a quoted code block`);

  // A long value is shortened, and says so.
  const long = outsideBlock('subject', 'y'.repeat(5_000));
  assert.match(long, /_Shortened to its first 2000 characters\._$/u);
  // A title with nothing to show still has a title.
  const blank = rendered(canonicalLinearTarget(linear({ title: { text: '{{subject}}' } })), { subject: ' ' });
  assert.equal(blank.title, 'Agent Comms: rule invoices');
});

test('E3: every try of one delivery names the same issue: its id is chosen from the delivery’s, as a v4 UUID', () => {
  const id = linearIssueId('dl-1');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(linearIssueId('dl-1'), id);
  assert.notEqual(linearIssueId('dl-2'), id);
});

test('E3: the approval preview names the team, the labels, the assignee, and which fields fill the title and description', () => {
  const document = {
    documentVersion: 1,
    kind: 'rule',
    rule: canonicalFullRuleDocument(rule(linear())),
  } as unknown as ActivationDocumentV1;
  const view = renderB3ApprovalPreviewV1({
    kind: 'READY',
    approvalId: 'ap_00000000000000000000000001',
    digest: 'a'.repeat(64),
    preview: document,
    challenge: {
      approvalId: 'ap_00000000000000000000000001',
      digest: 'a'.repeat(64),
      challenge: 'invoices',
      expiresAt: 1_000,
    },
  });
  const line = view.terminal.split('\n').find((entry) => entry.startsWith('Linear issue '));
  assert.equal(
    line,
    `Linear issue billing-issues@1: adds an issue in team CUE (${TEAM}) through Linear's API (api.linear.app), with your Linear key; label "Billing"; assigned to the Linear key's own user. Its title is filled from sender, subject; its description from subject, kind, each value from the message quoted as written by the sender.`,
  );
  assert.match(view.terminal, /^In plain words .*add an issue to Linear, team CUE\./mu);
  assert.match(
    describeRule(canonicalFullRuleDocument(rule(linear())))
      .map((part) => part.text)
      .join(''),
    /add an issue to Linear, team CUE\.$/u,
  );
});
