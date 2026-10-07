import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { z } from 'zod';
import { canonicalJson, EventsError, type JsonValue } from '../src/index.ts';
import type { ObjectNode, SchemaNode } from '../src/schema/describe.ts';
import { resolve } from '../src/schema/resolve.ts';
import { toJsonSchema, toRootJsonSchema } from '../src/schema/to-json-schema.ts';
import { toZod } from '../src/schema/to-zod.ts';
import { ajvOracle, checkStubFormat, mutationCorpus } from './support/schema-oracle.ts';

/**
 * The schema description, compiled to Zod and to JSON Schema 2020-12 (events phase A plan, decisions 5 and 6). Each
 * node kind compiles to decision 6's exact JSON; Zod and ajv, reading the two compilations of one description, agree
 * on every value of a mutation corpus, except the one named invariant a description can carry (`sorted`, decision 7);
 * lengths count code points; and the resolver finds the node at a path or refuses it.
 */

const ajv = ajvOracle();
const zod = (node: SchemaNode): z.ZodType => toZod(node, { checkFormat: checkStubFormat });

/** Asserts the node compiles to exactly `expected`, as a value and as canonical JSON. */
function compilesTo(node: SchemaNode, expected: JsonValue): void {
  const schema = toJsonSchema(node);
  assert.deepEqual(schema, expected);
  assert.equal(canonicalJson(schema), canonicalJson(expected));
  // And it is a schema ajv's strict 2020-12 mode compiles.
  ajv.compile(schema);
}

const ADDRESS: ObjectNode = {
  kind: 'object',
  properties: {
    address: { kind: 'string', format: 'email' },
    name: { kind: 'nullable', of: { kind: 'string' } },
  },
};

test('a nullable scalar and a nullable object are anyOf the node and null', () => {
  compilesTo({ kind: 'nullable', of: { kind: 'string' } }, { anyOf: [{ type: 'string' }, { type: 'null' }] });
  compilesTo(
    { kind: 'nullable', of: { kind: 'integer', minimum: 0 } },
    { anyOf: [{ type: 'number', multipleOf: 1, minimum: 0 }, { type: 'null' }] },
  );
  compilesTo(
    { kind: 'nullable', of: ADDRESS },
    {
      anyOf: [
        {
          type: 'object',
          properties: {
            address: { type: 'string', format: 'email' },
            name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
          required: ['address', 'name'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    },
  );
});

test('integer(minimum: 0) is a number with multipleOf 1 and the minimum, never type integer', () => {
  compilesTo({ kind: 'integer', minimum: 0 }, { type: 'number', multipleOf: 1, minimum: 0 });
  compilesTo({ kind: 'integer' }, { type: 'number', multipleOf: 1 });
});

test('strings, booleans, literals and enums are decision 6’s exact keywords', () => {
  compilesTo({ kind: 'string' }, { type: 'string' });
  compilesTo({ kind: 'string', minLength: 1 }, { type: 'string', minLength: 1 });
  compilesTo({ kind: 'string', pattern: /^ibx_[A-Z0-9]{16}$/u }, { type: 'string', pattern: '^ibx_[A-Z0-9]{16}$' });
  compilesTo({ kind: 'string', pattern: /^[0-9]+\.[0-9]{6}$/u }, { type: 'string', pattern: '^[0-9]+\\.[0-9]{6}$' });
  compilesTo({ kind: 'string', format: 'date-time' }, { type: 'string', format: 'date-time' });
  compilesTo({ kind: 'string', maxLength: 20000 }, { type: 'string', maxLength: 20000 });
  compilesTo({ kind: 'boolean' }, { type: 'boolean' });
  // Literals have no `type` keyword.
  compilesTo({ kind: 'const', value: 'gmail.message.received' }, { const: 'gmail.message.received' });
  compilesTo({ kind: 'const', value: 1 }, { const: 1 });
  compilesTo({ kind: 'const', value: false }, { const: false });
  // Enums keep Appendix A's order.
  compilesTo(
    { kind: 'enum', values: ['public_channel', 'private_channel', 'im', 'mpim'] },
    { type: 'string', enum: ['public_channel', 'private_channel', 'im', 'mpim'] },
  );
});

test('an object is strict, and its required list is sorted by UTF-8 bytes and present even when empty', () => {
  compilesTo(
    {
      kind: 'object',
      properties: {
        b: { kind: 'string' },
        // UTF-16 code units put U+1F600 (D83D …) before U+FF61; UTF-8 bytes put it after.
        '\u{1F600}': { kind: 'string' },
        '｡': { kind: 'string' },
        a: { kind: 'boolean' },
        B: { kind: 'boolean' },
        later: { kind: 'optional', of: { kind: 'string' } },
      },
    },
    {
      type: 'object',
      properties: {
        b: { type: 'string' },
        '\u{1F600}': { type: 'string' },
        '｡': { type: 'string' },
        a: { type: 'boolean' },
        B: { type: 'boolean' },
        later: { type: 'string' },
      },
      required: ['B', 'a', 'b', '｡', '\u{1F600}'],
      additionalProperties: false,
    },
  );
  compilesTo(
    { kind: 'object', properties: { only: { kind: 'optional', of: { kind: 'boolean' } } } },
    { type: 'object', properties: { only: { type: 'boolean' } }, required: [], additionalProperties: false },
  );
  compilesTo(
    { kind: 'object', properties: {} },
    { type: 'object', properties: {}, required: [], additionalProperties: false },
  );
});

test('uniqueItems, the string-union anyOf and dependentRequired; sorted emits no keyword', () => {
  compilesTo(
    { kind: 'array', items: { kind: 'string', minLength: 1 }, uniqueItems: true, sorted: true },
    { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
  );
  compilesTo({ kind: 'array', items: ADDRESS }, { type: 'array', items: toJsonSchema(ADDRESS) });
  compilesTo(
    {
      kind: 'union',
      of: [
        { kind: 'enum', values: ['text', 'image', 'unknown'] },
        { kind: 'string', pattern: /^unknown:[0-9]+$/u },
      ],
    },
    {
      anyOf: [
        { type: 'string', enum: ['text', 'image', 'unknown'] },
        { type: 'string', pattern: '^unknown:[0-9]+$' },
      ],
    },
  );
  compilesTo(
    {
      kind: 'object',
      properties: {
        body: { kind: 'optional', of: { kind: 'string', maxLength: 20000 } },
        bodyTruncated: { kind: 'optional', of: { kind: 'boolean' } },
      },
      dependentRequired: { body: ['bodyTruncated'], bodyTruncated: ['body'] },
    },
    {
      type: 'object',
      properties: { body: { type: 'string', maxLength: 20000 }, bodyTruncated: { type: 'boolean' } },
      required: [],
      additionalProperties: false,
      dependentRequired: { body: ['bodyTruncated'], bodyTruncated: ['body'] },
    },
  );
});

test('a root schema names the 2020-12 draft and its $id', () => {
  const root = toRootJsonSchema(
    { kind: 'object', properties: { id: { kind: 'string' } } },
    'urn:agentcomms:schema:source:sample.event:v1',
  );
  assert.deepEqual(root, {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:agentcomms:schema:source:sample.event:v1',
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  });
  ajv.compile(root);
});

test('a description the compilers cannot compile faithfully is refused, naming what is wrong', () => {
  const refused = (node: unknown, why: RegExp) => {
    for (const compile of [() => toJsonSchema(node as SchemaNode), () => zod(node as SchemaNode)]) {
      assert.throws(compile, (error: unknown) => {
        assert.ok(error instanceof EventsError, String(error));
        assert.equal(error.code, 'SCHEMA_DESCRIPTION_INVALID');
        assert.match(error.message, why);
        return true;
      });
    }
  };
  refused({ kind: 'enum', values: [] }, /enum/);
  refused({ kind: 'enum', values: ['a', 'a'] }, /enum/);
  // ajv reads a pattern with the u flag; a pattern without it could match differently in Zod.
  refused({ kind: 'string', pattern: /^a$/ }, /flag/);
  refused({ kind: 'string', pattern: /^a$/gu }, /flag/);
  refused({ kind: 'string', minLength: 2, maxLength: 1 }, /minLength/);
  refused({ kind: 'string', maxLength: 1.5 }, /maxLength/);
  refused({ kind: 'string', format: 'hostname' }, /format/);
  refused({ kind: 'array', items: { kind: 'integer' }, sorted: true }, /sorted/);
  refused({ kind: 'array', items: { kind: 'nullable', of: { kind: 'string' } }, sorted: true }, /sorted/);
  refused({ kind: 'nullable', of: { kind: 'nullable', of: { kind: 'string' } } }, /nullable/);
  refused({ kind: 'array', items: { kind: 'optional', of: { kind: 'string' } } }, /optional/);
  refused({ kind: 'union', of: [{ kind: 'string' }] }, /union/);
  refused({ kind: 'union', of: [{ kind: 'string' }, { kind: 'boolean' }] }, /union/);
  refused(
    { kind: 'object', properties: { a: { kind: 'string' } }, dependentRequired: { a: ['b'] } },
    /dependentRequired/,
  );
  refused({ kind: 'const', value: Number.NaN }, /const/);
  refused({ kind: 'integer', minimum: Number.POSITIVE_INFINITY }, /minimum/);
  refused({ kind: 'date' }, /kind/);
});

/** A description with every node kind at every kind of position: nested, nullable, in arrays and optional. */
const SAMPLE: ObjectNode = {
  kind: 'object',
  properties: {
    id: { kind: 'string', pattern: /^[0-9a-f]{8}$/u },
    type: { kind: 'const', value: 'sample.event' },
    version: { kind: 'const', value: 1 },
    fromMe: { kind: 'const', value: false },
    at: { kind: 'string', format: 'date-time' },
    name: { kind: 'string', minLength: 1 },
    note: { kind: 'nullable', of: { kind: 'string' } },
    count: { kind: 'integer', minimum: 0 },
    size: { kind: 'nullable', of: { kind: 'integer', minimum: 0 } },
    flag: { kind: 'boolean' },
    aligned: { kind: 'nullable', of: { kind: 'boolean' } },
    status: { kind: 'enum', values: ['open', 'closed'] },
    evaluatedBy: { kind: 'nullable', of: { kind: 'enum', values: ['resend'] } },
    messageKind: {
      kind: 'union',
      of: [
        { kind: 'enum', values: ['text', 'image', 'unknown'] },
        { kind: 'string', pattern: /^unknown:[0-9]+$/u },
      ],
    },
    labels: { kind: 'array', items: { kind: 'string', minLength: 1 }, uniqueItems: true, sorted: true },
    domains: { kind: 'array', items: { kind: 'string', format: 'domain' }, uniqueItems: true, sorted: true },
    flags: { kind: 'array', items: { kind: 'enum', values: ['archive', 'script'] }, uniqueItems: true, sorted: true },
    from: { kind: 'nullable', of: ADDRESS },
    to: { kind: 'array', items: ADDRESS },
    recipients: { kind: 'array', items: { kind: 'string', format: 'email' } },
    mentions: {
      kind: 'array',
      items: {
        kind: 'object',
        properties: {
          kind: { kind: 'enum', values: ['user', 'channel'] },
          id: { kind: 'string', minLength: 1 },
          label: { kind: 'nullable', of: { kind: 'string' } },
        },
      },
      uniqueItems: true,
    },
    author: {
      kind: 'object',
      properties: {
        userId: { kind: 'optional', of: { kind: 'string', minLength: 1 } },
        name: { kind: 'nullable', of: { kind: 'string' } },
      },
    },
    media: {
      kind: 'nullable',
      of: {
        kind: 'object',
        properties: {
          link: { kind: 'string', format: 'uri' },
          size: { kind: 'nullable', of: { kind: 'integer', minimum: 0 } },
        },
      },
    },
    emailId: { kind: 'optional', of: { kind: 'string', format: 'uuid' } },
    body: { kind: 'optional', of: { kind: 'string', maxLength: 5 } },
    bodyTruncated: { kind: 'optional', of: { kind: 'boolean' } },
  },
  dependentRequired: { body: ['bodyTruncated'], bodyTruncated: ['body'] },
};

/** Every optional present, every nullable not null, every array with items. */
const MAXIMAL: JsonValue = {
  id: '0123abcd',
  type: 'sample.event',
  version: 1,
  fromMe: false,
  at: '2026-10-06T12:00:00.123456Z',
  name: 'n',
  note: '',
  count: 0,
  size: 9007199254740992,
  flag: true,
  aligned: false,
  status: 'closed',
  evaluatedBy: 'resend',
  messageKind: 'unknown:42',
  labels: ['INBOX', 'Label_1', 'é', '\u{1F600}'],
  domains: ['a.example', 'b.example'],
  flags: ['archive', 'script'],
  from: { address: 'a@example.com', name: 'A' },
  to: [
    { address: 'b@example.com', name: null },
    { address: 'c@example.org', name: 'C' },
  ],
  recipients: ['d@example.com'],
  mentions: [
    { kind: 'user', id: 'U00000000', label: 'someone' },
    { kind: 'channel', id: 'C00000000', label: null },
  ],
  author: { userId: 'U00000000', name: 'someone' },
  media: { link: 'https://example.com/a', size: 0 },
  emailId: '00000000-0000-4000-8000-000000000000',
  body: '\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}',
  bodyTruncated: false,
};

/** Every optional absent, every nullable null, every array empty. */
const MINIMAL: JsonValue = {
  id: 'ffffffff',
  type: 'sample.event',
  version: 1,
  fromMe: false,
  at: '2026-10-06T12:00:00Z',
  name: 'n',
  note: null,
  count: 3,
  size: null,
  flag: false,
  aligned: null,
  status: 'open',
  evaluatedBy: null,
  messageKind: 'text',
  labels: [],
  domains: [],
  flags: [],
  from: null,
  to: [],
  recipients: [],
  mentions: [],
  author: { name: null },
  media: null,
};

test('Zod and ajv agree on every mutation of every valid value, except the named invariant', (t) => {
  const schema = zod(SAMPLE);
  const validate = ajv.compile(toRootJsonSchema(SAMPLE, 'urn:agentcomms:schema:source:sample.event:v1'));
  const counts: Record<string, number> = {};
  for (const valid of [MAXIMAL, MINIMAL]) {
    assert.equal(schema.safeParse(valid).success, true, JSON.stringify(schema.safeParse(valid).error?.issues));
    assert.equal(validate(valid), true, JSON.stringify(validate.errors));
    for (const mutation of mutationCorpus(SAMPLE, valid)) {
      const byZod = schema.safeParse(mutation.value).success;
      const byAjv = validate(mutation.value);
      const expected = { refused: [false, false], accepted: [true, true], 'zod-only': [false, true] }[mutation.expect];
      assert.deepEqual([byZod, byAjv], expected, `${mutation.name} (${mutation.rule}): zod ${byZod}, ajv ${byAjv}`);
      counts[mutation.rule] = (counts[mutation.rule] ?? 0) + 1;
    }
  }
  // The corpus reaches every rule it is meant to: none silently made nothing.
  for (const rule of [
    'required',
    'additionalProperties',
    'null',
    'type',
    'const',
    'enum',
    'anyOf',
    'maxLength',
    'minLength',
    'pattern',
    'format',
    'multipleOf',
    'minimum',
    'uniqueItems',
    'dependentRequired',
    'sorted',
    'optional',
    'nullable',
  ]) {
    assert.ok((counts[rule] ?? 0) > 0, `the corpus made no ${rule} mutation`);
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  t.diagnostic(`${total} mutations: ${JSON.stringify(counts)}`);
});

test('the sorted invariant is raw UTF-8 order, which Zod checks and JSON Schema cannot', () => {
  const sorted = zod({ kind: 'array', items: { kind: 'string' }, sorted: true });
  // U+FF61 before U+1F600 by UTF-8 bytes, though UTF-16 code units order them the other way.
  assert.equal(sorted.safeParse(['｡', '\u{1F600}']).success, true);
  assert.equal(sorted.safeParse(['\u{1F600}', '｡']).success, false);
  assert.equal(sorted.safeParse(['B', 'a']).success, true);
  assert.equal(sorted.safeParse(['a', 'B']).success, false);
  // Equal neighbours are uniqueItems' business, not sorting's.
  assert.equal(sorted.safeParse(['a', 'a']).success, true);
  assert.equal(sorted.safeParse([]).success, true);
});

test('lengths count code points: astral and BMP strings alike, and lone surrogates one each', () => {
  const cases: [SchemaNode, string, boolean][] = [
    [{ kind: 'string', maxLength: 3 }, '\u{1F600}\u{1F600}\u{1F600}', true],
    [{ kind: 'string', maxLength: 3 }, 'abc', true],
    [{ kind: 'string', maxLength: 3 }, '\u{1F600}\u{1F600}\u{1F600}\u{1F600}', false],
    [{ kind: 'string', maxLength: 3 }, 'abcd', false],
    [{ kind: 'string', maxLength: 3 }, '\uD800𐀀', true],
    [{ kind: 'string', minLength: 1 }, '', false],
    [{ kind: 'string', minLength: 1 }, '\u{1F600}', true],
    [{ kind: 'string', minLength: 2 }, '\u{1F600}', false],
    [{ kind: 'string', minLength: 2 }, '\uDC00\uD800', true],
  ];
  for (const [node, text, ok] of cases) {
    const label = `${JSON.stringify(toJsonSchema(node))} on ${JSON.stringify(text)}`;
    assert.equal(zod(node).safeParse(text).success, ok, `zod: ${label}`);
    assert.equal(ajv.compile(toJsonSchema(node))(text), ok, `ajv: ${label}`);
  }
});

test('an integer is any JSON number that is a whole number, however large, at or above its minimum', () => {
  const node: SchemaNode = { kind: 'integer', minimum: 0 };
  const validate = ajv.compile(toJsonSchema(node));
  for (const [value, ok] of [
    [0, true],
    [-0, true],
    [7, true],
    [2 ** 53, true],
    [2 ** 53 + 2, true],
    [1.5, false],
    [4.000000000000001, false],
    [-1, false],
    [1e-7, false],
  ] as const) {
    assert.equal(zod(node).safeParse(value).success, ok, `zod: ${value}`);
    assert.equal(validate(value), ok, `ajv: ${value}`);
  }
});

test('resolve returns the node at a token path, through nullable parents, and says whether it is optional', () => {
  const at = (path: Parameters<typeof resolve>[1]) => {
    const found = resolve(SAMPLE, path);
    assert.ok(found.ok, JSON.stringify(found));
    return found.value;
  };
  assert.deepEqual(at([]), { node: SAMPLE, optional: false });
  assert.deepEqual(at(['from', 'address']), { node: ADDRESS.properties.address, optional: false });
  assert.deepEqual(at(['to', { any: true }, 'name']), { node: ADDRESS.properties.name, optional: false });
  assert.deepEqual(at(['to', 0, 'name']), { node: ADDRESS.properties.name, optional: false });
  assert.deepEqual(at(['labels', 3]), { node: { kind: 'string', minLength: 1 }, optional: false });
  assert.deepEqual(at(['body']), { node: { kind: 'string', maxLength: 5 }, optional: true });
  assert.deepEqual(at(['author', 'userId']), { node: { kind: 'string', minLength: 1 }, optional: true });
  assert.deepEqual(at(['media', 'size']), {
    node: { kind: 'nullable', of: { kind: 'integer', minimum: 0 } },
    optional: false,
  });
  // The nullable parent itself is returned as declared.
  assert.equal(at(['from']).node.kind, 'nullable');
});

test('resolve refuses an undeclared object key, a token of the wrong kind, and a step below a scalar', () => {
  const refused = (path: Parameters<typeof resolve>[1], why: RegExp) => {
    const found = resolve(SAMPLE, path);
    assert.equal(found.ok, false, JSON.stringify(path));
    if (found.ok) return;
    assert.equal(found.issues.length, 1);
    assert.equal(found.issues[0]?.code, 'POINTER_NOT_IN_SCHEMA');
    assert.match(found.issues[0]?.message ?? '', why);
  };
  refused(['nope'], /no property "nope"/);
  refused(['from', 'adress'], /no property "adress"/);
  // Own properties only: what every object inherits is not declared.
  refused(['constructor'], /no property "constructor"/);
  refused(['__proto__'], /no property "__proto__"/);
  refused(['author', 'toString'], /no property "toString"/);
  // An index on an object; a key on an array.
  refused([0], /an index on an object/);
  refused([{ any: true }], /an index on an object/);
  refused(['to', 'name'], /a key on an array/);
  refused(['to', '0'], /a key on an array/);
  refused(['to', -1], /index/);
  refused(['to', 1.5], /index/);
  // Below a scalar, a nullable scalar included.
  refused(['name', 'length'], /below a string/);
  refused(['note', 'x'], /below a string/);
  refused(['count', 0], /below an integer/);
  refused(['messageKind', 'x'], /below a union/);
  // A malformed token.
  refused(['to', { any: false } as unknown as { any: true }], /token/);
});
