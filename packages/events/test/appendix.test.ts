import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyProseRules,
  checkProseRules,
  type Extraction,
  extractAppendix,
  type ProseRules,
  unaccountedComments,
  uncoveredSentences,
} from './appendix/extract.ts';
import {
  compareRecordSets,
  decisionSixProblems,
  type FieldRecord,
  readTranscription,
  type Transcription,
} from './appendix/records.ts';

/**
 * Appendix A, read twice (events phase A plan, Task 10). The extractor (`test/appendix/extract.ts`) reads the
 * spec's text by A.1's own notation rules; the transcription (`test/fixtures/catalogue-v1.json`) is a person's
 * reading, written by hand; the prose-rule file (`test/fixtures/appendix-prose-rules.json`) quotes, verbatim, every
 * sentence or comment no machine can map, and says what each becomes. The transcription must equal the extraction
 * constraint for constraint, so a fixture and a definition (Task 11) that are wrong the same way still fail.
 *
 * Each input can be pointed at a copy, which is how the task's mutations are run: `EVENTS_APPENDIX_SPEC`,
 * `EVENTS_APPENDIX_TRANSCRIPTION` and `EVENTS_APPENDIX_PROSE_RULES`.
 */

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SPEC =
  process.env.EVENTS_APPENDIX_SPEC ??
  join(PACKAGE_ROOT, '..', '..', 'docs', 'superpowers', 'specs', '2026-10-05-local-event-emission-design.md');
const TRANSCRIPTION =
  process.env.EVENTS_APPENDIX_TRANSCRIPTION ?? join(PACKAGE_ROOT, 'test', 'fixtures', 'catalogue-v1.json');
const PROSE_RULES =
  process.env.EVENTS_APPENDIX_PROSE_RULES ?? join(PACKAGE_ROOT, 'test', 'fixtures', 'appendix-prose-rules.json');

const SEVEN = [
  'gmail.message.received',
  'gmail.message.sent',
  'gmail.message.labelled',
  'slack.message.posted',
  'resend.email.received',
  'resend.email.status_changed',
  'whatsapp.message.received',
];

const spec = readFileSync(SPEC, 'utf8');
const transcription = JSON.parse(readFileSync(TRANSCRIPTION, 'utf8')) as Transcription;
const proseRules = JSON.parse(readFileSync(PROSE_RULES, 'utf8')) as ProseRules;

/** The mechanical extraction, before any prose rule is applied. */
function extraction(): Extraction {
  return extractAppendix(spec);
}

/** One extracted field record, which must exist. */
function field(from: Extraction, type: string, path: string): FieldRecord {
  const found = from.types.find((entry) => entry.type === type);
  assert.ok(found, `the extraction has no type ${type}`);
  const record = found.records[path];
  assert.ok(record, `${type} has no position ${path || '(root)'}`);
  return record;
}

test('A8-b: every normative constraint of Appendix A is extracted', () => {
  const extracted = extraction();
  assert.deepEqual(
    extracted.types.map((entry) => entry.type),
    SEVEN,
    'the extractor finds exactly the seven types, in Appendix A order',
  );

  // One field of every kind, picked by hand from the spec.
  assert.deepEqual(field(extracted, 'gmail.message.received', '/id'), {
    optional: false,
    nullable: false,
    kind: 'string',
    pattern: '^[0-9a-f]{32}$',
  });
  for (const type of ['gmail.message.received', 'gmail.message.sent', 'gmail.message.labelled']) {
    assert.equal(field(extracted, type, '/account/id').pattern, '^ibx_[A-Z0-9]{16}$', type);
  }
  for (const type of ['slack.message.posted', 'resend.email.received', 'whatsapp.message.received']) {
    assert.equal(field(extracted, type, '/account/id').pattern, '^acc_[A-Z0-9]{16}$', type);
  }
  assert.deepEqual(field(extracted, 'gmail.message.labelled', '/account/channel'), {
    optional: false,
    nullable: false,
    kind: 'const',
    const: 'gmail',
  });
  assert.deepEqual(field(extracted, 'gmail.message.received', '/labels'), {
    optional: false,
    nullable: false,
    kind: 'array',
    uniqueItems: true,
    sortedUtf8: true,
  });
  assert.deepEqual(field(extracted, 'gmail.message.received', '/labels/*'), {
    optional: false,
    nullable: false,
    kind: 'string',
    minLength: 1,
  });
  assert.deepEqual(field(extracted, 'gmail.message.sent', '/authentication/ignoredHeaders'), {
    optional: false,
    nullable: false,
    kind: 'number',
    multipleOf: 1,
    minimum: 0,
  });
  assert.deepEqual(field(extracted, 'gmail.message.received', '/from'), {
    optional: false,
    nullable: true,
    kind: 'object',
    additionalProperties: false,
  });
  assert.deepEqual(field(extracted, 'gmail.message.received', '/from/address'), {
    optional: false,
    nullable: false,
    kind: 'string',
    format: 'email',
  });
  assert.deepEqual(field(extracted, 'resend.email.received', '/body'), {
    optional: true,
    nullable: false,
    kind: 'string',
    maxLength: 20000,
  });
  assert.deepEqual(field(extracted, 'resend.email.received', '').dependentRequired, {
    body: ['bodyTruncated'],
    bodyTruncated: ['body'],
  });
  assert.equal(field(extracted, 'gmail.message.received', '/body').maxLength, undefined, 'Gmail’s body has no limit');
  assert.deepEqual(field(extracted, 'whatsapp.message.received', '/fromMe'), {
    optional: false,
    nullable: false,
    kind: 'const',
    const: false,
  });
  assert.deepEqual(field(extracted, 'gmail.message.received', '/version'), {
    optional: false,
    nullable: false,
    kind: 'const',
    const: 1,
  });
  const kind = {
    optional: false,
    nullable: false,
    kind: 'anyOf',
    branches: [
      {
        kind: 'enum',
        enum: [
          'text',
          'image',
          'video',
          'audio',
          'contact',
          'location',
          'group-event',
          'link',
          'document',
          'system',
          'gif',
          'waiting',
          'deleted',
          'sticker',
          'poll',
          'video-note',
          'call',
          'album',
          'unknown',
        ],
      },
      { kind: 'string', pattern: '^unknown:[0-9]+$' },
    ],
  };
  assert.deepEqual(field(extracted, 'whatsapp.message.received', '/kind'), kind);
  assert.deepEqual(field(extracted, 'whatsapp.message.received', '/media/type'), kind);
  assert.deepEqual(field(extracted, 'resend.email.received', '/emailId'), {
    optional: false,
    nullable: false,
    kind: 'string',
    format: 'uuid',
  });
  assert.deepEqual(field(extracted, 'resend.email.received', '/authentication/evaluatedBy'), {
    optional: false,
    nullable: true,
    kind: 'enum',
    enum: ['resend'],
  });
  assert.equal(field(extracted, 'slack.message.posted', '/author/userId').optional, true);
  assert.deepEqual(
    extracted.types.find((entry) => entry.type === 'gmail.message.labelled')?.metadata,
    {
      untrusted: [],
      content: [],
      addresses: [],
      handles: [],
      formats: [
        { pattern: ['occurredAt'], format: 'date-time' },
        { pattern: ['observedAt'], format: 'date-time' },
      ],
    },
    'A.3’s inline lists and its fenced formats',
  );

  // Nothing the notation does not map is dropped: every other comment and every constraint-bearing sentence is
  // accounted for by a prose rule.
  assert.deepEqual(unaccountedComments(extracted, proseRules), []);
  assert.deepEqual(uncoveredSentences(extracted, proseRules), []);
});

test('A8-a: the transcription follows decision 6', () => {
  const extracted = extraction();
  assert.deepEqual(
    transcription.types.map((entry) => entry.type),
    SEVEN,
    'the transcription holds the seven types, in Appendix A order',
  );
  for (const entry of transcription.types) {
    assert.deepEqual(decisionSixProblems(entry, extracted.grammar), [], entry.type);
  }
});

test('A8-c: the transcription equals the extraction, constraint for constraint', () => {
  // The prose rules must apply cleanly (each keyword agrees with the notation, each invariant names a position), and
  // then every record, metadata list, invariant and descriptor must agree. Both lists are reported together.
  const extracted = applyProseRules(extraction(), proseRules);
  const transcribed = transcription.types.map((entry) => readTranscription(entry));
  assert.deepEqual([...extracted.problems, ...compareRecordSets(extracted.types, transcribed)], []);
  const positions = extracted.types.reduce((sum, type) => sum + Object.keys(type.records).length, 0);
  assert.ok(positions > 250, `only ${positions} field positions were compared`);
});

test('A8-d: every prose rule is quoted verbatim, every constraint-bearing sentence is covered, and invariants match one to one', () => {
  const extracted = extraction();
  const problems = checkProseRules(extracted, proseRules, transcription);
  assert.deepEqual(problems.verbatim, [], 'every quote is verbatim in Appendix A, where its types are defined');
  assert.deepEqual(problems.shape, [], 'every rule names known types and one closed kind of result');
  assert.deepEqual(problems.coverage, [], 'every constraint-bearing sentence and comment is covered');
  assert.deepEqual(problems.oneToOne, [], 'every invariant has exactly one rule, and every rule’s invariant exists');
});
