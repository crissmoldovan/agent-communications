import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  EventsError,
  expandPattern,
  formatPointer,
  getPointer,
  type JsonValue,
  matchesPattern,
  type PointerPattern,
  parsePointer,
  relatePointers,
} from '../src/index.ts';
import { checkPattern } from '../src/pattern.ts';
import { resolvePointer } from '../src/pointer.ts';
import type { ObjectNode } from '../src/schema/describe.ts';
import { PACKAGE_ROOT } from './support/realm.ts';

/**
 * RFC 6901 pointers and D3's pointer patterns (events phase A plan, Task 9). The vector file
 * (`test/vectors/pointers.json`) runs in Node, the bare realm and the browsers; this holds the library to the cases
 * the plan names, and covers what only Node can show — objects that inherit what JSON never makes, and the
 * schema-aware checks against a description, which holds regular expressions and so cannot be a vector.
 */

const file = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'test', 'vectors', 'pointers.json'), 'utf8'));
const vectors = (kind: string) => file.vectors.filter((vector: { kind: string }) => vector.kind === kind);

/** Asserts `run` throws the library's refusal with `code`. */
function throwsCode(run: () => unknown, code: string, what?: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof EventsError, String(error));
    assert.equal(error.code, code);
    if (what !== undefined) assert.match(error.message, what);
    return true;
  });
}

const tokens = (pointer: string): readonly string[] => {
  const parsed = parsePointer(pointer);
  assert.ok(parsed.ok, `${pointer}: ${JSON.stringify(parsed)}`);
  return parsed.value;
};

test('CAT-e: RFC 6901, exactly: the root, the empty key, escapes, indices and the literal *', () => {
  assert.deepEqual(tokens(''), []);
  assert.deepEqual(tokens('/'), ['']);
  assert.deepEqual(tokens('/a~1b/~0c'), ['a/b', '~c']);
  assert.equal(formatPointer(['a/b', '~c']), '/a~1b/~0c');
  // ~01 is ~ followed by 1: the escapes are undone in one pass, never twice.
  assert.deepEqual(tokens('/~01'), ['~1']);
  assert.equal(formatPointer(['~1']), '/~01');
  assert.deepEqual(tokens('/*'), ['*']);
  // Every parse vector round-trips through formatPointer, and every format vector through parsePointer.
  for (const vector of vectors('parse').filter((v: { tokens?: unknown }) => v.tokens !== undefined)) {
    assert.equal(formatPointer(vector.tokens), vector.pointer, vector.name);
  }
  for (const vector of vectors('format').filter((v: { pointer?: unknown }) => v.pointer !== undefined)) {
    assert.deepEqual(tokens(vector.pointer), vector.tokens.map(String), vector.name);
  }

  // /0 is index 0; a leading zero and - are refused on an array, and are ordinary keys on an object.
  const list: JsonValue = ['a', 'b'];
  assert.deepEqual(getPointer(list, '/0'), { found: true, value: 'a' });
  throwsCode(() => getPointer(list, '/01'), 'POINTER_NOT_IN_SCHEMA', /not an array index/);
  throwsCode(() => getPointer(list, '/-'), 'POINTER_NOT_IN_SCHEMA', /not an array index/);
  const keys: JsonValue = { '0': 'zero', '01': 'zero-one', '-': 'dash' };
  assert.deepEqual(getPointer(keys, '/0'), { found: true, value: 'zero' });
  assert.deepEqual(getPointer(keys, '/01'), { found: true, value: 'zero-one' });
  assert.deepEqual(getPointer(keys, '/-'), { found: true, value: 'dash' });
  // * is a literal key, and no index.
  assert.deepEqual(getPointer({ '*': 1, x: 2 }, '/*'), { found: true, value: 1 });
  throwsCode(() => getPointer([1], '/*'), 'POINTER_NOT_IN_SCHEMA');

  // A malformed escape, a trailing ~, and a pointer without its leading / are refused.
  for (const pointer of ['/~2', '/a~', '/~', 'a', '#/a']) {
    const parsed = parsePointer(pointer);
    assert.equal(parsed.ok, false, pointer);
    if (!parsed.ok) assert.equal(parsed.issues[0]?.code, 'POINTER_MALFORMED', pointer);
    throwsCode(() => getPointer({}, pointer), 'POINTER_MALFORMED');
    throwsCode(() => relatePointers(pointer, ''), 'POINTER_MALFORMED');
    throwsCode(() => matchesPattern([], pointer), 'POINTER_MALFORMED');
  }
  throwsCode(() => formatPointer([-1]), 'POINTER_MALFORMED');
  throwsCode(() => formatPointer([0.5]), 'POINTER_MALFORMED');
});

test('CAT-g: own properties only: __proto__, constructor and prototype are data, never inherited', () => {
  // Made by JSON.parse, as an event is: the three are own properties.
  const own = JSON.parse('{"__proto__": {"polluted": true}, "constructor": "c", "prototype": "p"}') as JsonValue;
  assert.deepEqual(getPointer(own, '/__proto__'), { found: true, value: { polluted: true } });
  assert.deepEqual(getPointer(own, '/__proto__/polluted'), { found: true, value: true });
  assert.deepEqual(getPointer(own, '/constructor'), { found: true, value: 'c' });
  assert.deepEqual(getPointer(own, '/prototype'), { found: true, value: 'p' });
  assert.deepEqual(expandPattern(['__proto__', 'polluted'], own), ['/__proto__/polluted']);

  // An object that merely inherits them has none of them.
  const plain: JsonValue = {};
  for (const pointer of ['/__proto__', '/constructor', '/constructor/name', '/toString', '/hasOwnProperty']) {
    assert.deepEqual(getPointer(plain, pointer), { found: false }, pointer);
  }
  const inherits = Object.create({ prototype: 1, constructor: 2, own: 3 }) as JsonValue;
  for (const pointer of ['/prototype', '/constructor', '/own']) {
    assert.deepEqual(getPointer(inherits, pointer), { found: false }, pointer);
  }
  assert.deepEqual(expandPattern(['prototype'], inherits), []);
  assert.deepEqual(expandPattern(['constructor'], plain), []);
  // An array's own length is not an element.
  throwsCode(() => getPointer(['a'], '/length'), 'POINTER_NOT_IN_SCHEMA');
  assert.equal(Object.getPrototypeOf(plain), Object.prototype, 'nothing was written through __proto__');
});

/** A description shaped like a catalogue event: nullable parents, optional fields, arrays of objects and strings. */
const EVENT: ObjectNode = {
  kind: 'object',
  properties: {
    from: {
      kind: 'nullable',
      of: {
        kind: 'object',
        properties: {
          address: { kind: 'string', format: 'email' },
          name: { kind: 'nullable', of: { kind: 'string' } },
        },
      },
    },
    to: {
      kind: 'array',
      items: {
        kind: 'object',
        properties: {
          address: { kind: 'string', format: 'email' },
          name: { kind: 'nullable', of: { kind: 'string' } },
        },
      },
    },
    cc: { kind: 'array', items: { kind: 'string', format: 'email' } },
    mentions: {
      kind: 'array',
      items: {
        kind: 'object',
        properties: { ids: { kind: 'array', items: { kind: 'string', minLength: 1 } } },
      },
    },
    keyed: { kind: 'object', properties: { '0': { kind: 'string' }, '-': { kind: 'string' } } },
    body: { kind: 'optional', of: { kind: 'string' } },
  },
};

test('CAT-d: patterns are valid only on the schema’s shape, and expand to every present index', () => {
  const ok = (pattern: PointerPattern) => {
    const found = checkPattern(EVENT, pattern);
    assert.ok(found.ok, `${JSON.stringify(pattern)}: ${JSON.stringify(found)}`);
    return found.value.node;
  };
  const refused = (pattern: unknown, code: string, why: RegExp) => {
    const found = checkPattern(EVENT, pattern as PointerPattern);
    assert.equal(found.ok, false, JSON.stringify(pattern));
    if (found.ok) return;
    assert.equal(found.issues[0]?.code, code, JSON.stringify(pattern));
    assert.match(found.issues[0]?.message ?? '', why);
  };
  assert.deepEqual(ok(['from', 'address']), { kind: 'string', format: 'email' });
  assert.deepEqual(ok(['to', { any: true }, 'address']), { kind: 'string', format: 'email' });
  assert.deepEqual(ok(['cc', { any: true }]), { kind: 'string', format: 'email' });
  assert.deepEqual(ok(['mentions', { any: true }, 'ids', { any: true }]), { kind: 'string', minLength: 1 });
  assert.equal(ok(['body']).kind, 'string');
  // { any: true } on an object, and a string token on an array, are refused.
  refused(['from', { any: true }], 'POINTER_NOT_IN_SCHEMA', /an index on an object/);
  refused([{ any: true }], 'POINTER_NOT_IN_SCHEMA', /an index on an object/);
  refused(['to', 'address'], 'POINTER_NOT_IN_SCHEMA', /a key on an array/);
  refused(['to', '0', 'address'], 'POINTER_NOT_IN_SCHEMA', /a key on an array/);
  refused(['from', 'adress'], 'POINTER_NOT_IN_SCHEMA', /no property "adress"/);
  refused(['constructor'], 'POINTER_NOT_IN_SCHEMA', /no property "constructor"/);
  refused(['from', 'address', 'x'], 'POINTER_NOT_IN_SCHEMA', /below a string/);
  // A pattern is strings and { any: true }, nothing else: not an index, not { any: false }.
  refused(['to', 0, 'address'], 'POINTER_MALFORMED', /pattern token/);
  refused(['to', { any: false }], 'POINTER_MALFORMED', /pattern token/);
  refused(['to', { any: true, also: 1 }], 'POINTER_MALFORMED', /pattern token/);
  refused('to', 'POINTER_MALFORMED', /pattern/);

  // A concrete pointer against the schema: an index on an array, an ordinary key on an object.
  const pointer = (text: string) => resolvePointer(EVENT, text);
  assert.deepEqual(pointer('/to/0/address'), {
    ok: true,
    value: { node: { kind: 'string', format: 'email' }, optional: false },
  });
  assert.equal(pointer('/to/12').ok, true);
  assert.equal(pointer('/keyed/0').ok, true);
  assert.equal(pointer('/keyed/-').ok, true);
  assert.equal(pointer('/body').ok, true);
  for (const [text, code] of [
    ['/to/01/address', 'POINTER_NOT_IN_SCHEMA'],
    ['/to/-', 'POINTER_NOT_IN_SCHEMA'],
    ['/to/address', 'POINTER_NOT_IN_SCHEMA'],
    ['/keyed/01', 'POINTER_NOT_IN_SCHEMA'],
    ['/from/0', 'POINTER_NOT_IN_SCHEMA'],
    ['/__proto__', 'POINTER_NOT_IN_SCHEMA'],
    ['/to/~2', 'POINTER_MALFORMED'],
  ] as const) {
    const found = pointer(text);
    assert.equal(found.ok, false, text);
    if (!found.ok) assert.equal(found.issues[0]?.code, code, text);
  }

  // Expansion escapes keys, skips what is absent or null, and walks nested indices in order.
  const event = {
    from: null,
    to: [
      { address: 'a@example.com', name: 'A' },
      { address: 'b@example.com', name: null },
    ],
    cc: [],
    mentions: [{ ids: ['U00000001', 'U00000002'] }, { ids: [] }, { ids: ['U00000003'] }],
    keyed: { '0': 'zero', '-': 'dash' },
  };
  assert.deepEqual(expandPattern(['from', 'address'], event), [], 'a null parent contributes nothing');
  assert.deepEqual(expandPattern(['body'], event), [], 'an absent optional contributes nothing');
  assert.deepEqual(expandPattern(['to', { any: true }, 'name'], event), ['/to/0/name']);
  assert.deepEqual(expandPattern(['to', { any: true }, 'address'], event), ['/to/0/address', '/to/1/address']);
  assert.deepEqual(expandPattern(['cc', { any: true }], event), []);
  assert.deepEqual(expandPattern(['mentions', { any: true }, 'ids', { any: true }], event), [
    '/mentions/0/ids/0',
    '/mentions/0/ids/1',
    '/mentions/2/ids/0',
  ]);
  assert.deepEqual(expandPattern(['a/b', '~c'], { 'a/b': { '~c': 1 } }), ['/a~1b/~0c']);
  // Every expanded pointer finds its value, and matches the pattern it came from.
  for (const pattern of [
    ['to', { any: true }, 'address'],
    ['mentions', { any: true }, 'ids', { any: true }],
    ['keyed', '0'],
    ['keyed', '-'],
  ] as const) {
    for (const concrete of expandPattern(pattern, event)) {
      assert.equal(getPointer(event, concrete).found, true, concrete);
      assert.equal(matchesPattern(pattern, concrete), true, concrete);
    }
  }
  // The vectors' expansions match their patterns too.
  for (const vector of vectors('expand').filter((v: { pointers?: unknown }) => v.pointers !== undefined)) {
    for (const concrete of vector.pointers) assert.equal(matchesPattern(vector.pattern, concrete), true, vector.name);
  }
});

test('CAT-f: equal, ancestor, descendant or disjoint, token by token', () => {
  const cases: [string, string, string][] = [
    ['', '', 'equal'],
    ['', '/a', 'ancestor'],
    ['/a', '', 'descendant'],
    ['/', '', 'descendant'],
    ['/', '//', 'ancestor'],
    ['/a/b', '/a/b', 'equal'],
    ['/a', '/a/b', 'ancestor'],
    ['/a/b', '/a', 'descendant'],
    // Siblings sharing a prefix: a string prefix, and no ancestor.
    ['/a/b', '/a/bc', 'disjoint'],
    ['/a/bc', '/a/b', 'disjoint'],
    // An escaped / is one key.
    ['/a~1b', '/a/b', 'disjoint'],
    ['/a/b', '/a~1b', 'disjoint'],
    ['/a~1b', '/a~1b/c', 'ancestor'],
    ['/~0', '/~1', 'disjoint'],
    // Indices.
    ['/to/0', '/to/0/name', 'ancestor'],
    ['/to/0', '/to/1', 'disjoint'],
    ['/to/1', '/to/10', 'disjoint'],
    ['/to/10/name', '/to/1', 'disjoint'],
  ];
  for (const [a, b, relation] of cases) assert.equal(relatePointers(a, b), relation, `${a} against ${b}`);
  for (const vector of vectors('relate').filter((v: { relation?: unknown }) => v.relation !== undefined)) {
    assert.equal(relatePointers(vector.a, vector.b), vector.relation, vector.name);
  }
});
