import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type AnyEventDefinition, CATALOGUE, describeFields } from '../src/catalogue/index.ts';
import { canonicaliseAgenticCondition } from '../src/conditions/agentic.ts';
import { CONDITION_LIMITS, canonicaliseCondition } from '../src/conditions/canonicalise.ts';
import { describeCondition } from '../src/conditions/describe.ts';
import { evaluateCondition } from '../src/conditions/evaluate.ts';
import type { AuthoringCondition, CanonicalCondition } from '../src/conditions/types.ts';
import { canonicalJson, type JsonValue } from '../src/json.ts';
import { formatPointer, parsePointer, resolvePointer } from '../src/pointer.ts';
import { nonNull, type SchemaNode } from '../src/schema/describe.ts';
import { PACKAGE_ROOT } from './support/realm.ts';

/** Task 12's committed D5 operator matrix and golden condition vectors. */
const FILE = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'test', 'vectors', 'conditions.json'), 'utf8')) as {
  legality: readonly { readonly op: string; readonly kinds: readonly string[]; readonly formats: readonly string[] }[];
  vectors: readonly Record<string, unknown>[];
};

const definition = (type: string): AnyEventDefinition => {
  const found = CATALOGUE.find((candidate) => candidate.type === type);
  assert.ok(found, `catalogue definition ${type}`);
  return found;
};

const codeOf = (result: ReturnType<typeof canonicaliseCondition> | ReturnType<typeof canonicaliseAgenticCondition>) => {
  assert.equal(result.ok, false, 'expected refusal');
  return result.ok ? undefined : result.issues[0]?.code;
};

const canonical = (type: string, condition: unknown): CanonicalCondition => {
  const result = canonicaliseCondition(definition(type), condition);
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
};

type MutableObject = Record<string, JsonValue>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function setAt(value: MutableObject, pointer: string, replacement: JsonValue): void {
  const parsed = parsePointer(pointer);
  assert.ok(parsed.ok, pointer);
  assert.ok(parsed.value.length > 0, 'the test does not replace a root value');
  let at: MutableObject | JsonValue[] = value;
  for (let index = 0; index < parsed.value.length - 1; index += 1) {
    const token = parsed.value[index] as string;
    const next = parsed.value[index + 1] as string;
    const child: JsonValue | undefined = Array.isArray(at) ? at[Number(token)] : at[token];
    const replacementChild: MutableObject | JsonValue[] =
      child !== null && typeof child === 'object'
        ? (child as MutableObject | JsonValue[])
        : /^(?:0|[1-9][0-9]*)$/u.test(next)
          ? []
          : {};
    if (Array.isArray(at)) at[Number(token)] = replacementChild;
    else at[token] = replacementChild;
    at = replacementChild;
  }
  const last = parsed.value.at(-1) as string;
  if (Array.isArray(at)) at[Number(last)] = replacement;
  else at[last] = replacement;
}

function sample(node: SchemaNode): string | number | boolean {
  const inner = nonNull(node);
  switch (inner.kind) {
    case 'string': {
      if (inner.format === 'date-time') return '2026-10-07T12:00:00Z';
      if (inner.format === 'email') return 'recipient@example.com';
      if (inner.format === 'domain') return 'example.com';
      if (inner.format === 'uuid') return '01234567-89ab-cdef-0123-456789abcdef';
      if (inner.pattern?.test('0123456789abcdef0123456789abcdef')) return '0123456789abcdef0123456789abcdef';
      if (inner.pattern?.test('ibx_ABCDEFGHIJKLMNOP')) return 'ibx_ABCDEFGHIJKLMNOP';
      if (inner.pattern?.test('acc_ABCDEFGHIJKLMNOP')) return 'acc_ABCDEFGHIJKLMNOP';
      if (inner.pattern?.test('0.000000')) return '0.000000';
      if (inner.pattern?.test('unknown:0')) return 'unknown:0';
      return 'sample';
    }
    case 'integer':
      return Math.max(0, inner.minimum ?? 0);
    case 'boolean':
      return false;
    case 'const':
      return inner.value;
    case 'enum':
      return inner.values[0] as string;
    case 'union':
      return sample(inner.of[0] as SchemaNode);
    case 'array':
    case 'object':
      throw new Error('a condition operand is scalar');
  }
}

function mismatch(value: JsonValue): JsonValue {
  if (typeof value === 'string') return 'unrelated';
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'boolean') return !value;
  return 'unrelated';
}

function assertLeafEvaluation(
  definition: AnyEventDefinition,
  pointer: string,
  node: SchemaNode,
  condition: CanonicalCondition,
): void {
  if (!('op' in condition)) assert.fail('catalogue legality probes must be leaf conditions');
  const matching: MutableObject = {};
  const nonMatching: MutableObject = {};
  const scalar = condition.op === 'in' ? condition.values[0] : 'value' in condition ? condition.value : undefined;
  const inner = nonNull(node);
  const different =
    inner.kind === 'string' && inner.format === 'date-time' ? '2026-10-07T12:00:01Z' : mismatch(scalar as JsonValue);

  switch (condition.op) {
    case 'exists':
      setAt(matching, pointer, true);
      break;
    case 'equals':
      setAt(matching, pointer, scalar as JsonValue);
      setAt(nonMatching, pointer, different);
      break;
    case 'notEquals':
      setAt(matching, pointer, different);
      setAt(nonMatching, pointer, scalar as JsonValue);
      break;
    case 'in':
      setAt(matching, pointer, scalar as JsonValue);
      setAt(nonMatching, pointer, different);
      break;
    case 'contains':
      if (inner.kind === 'array') {
        setAt(matching, pointer, [scalar as JsonValue]);
        setAt(nonMatching, pointer, [different]);
      } else {
        setAt(matching, pointer, `before ${scalar as string} after`);
        setAt(nonMatching, pointer, 'unrelated');
      }
      break;
    case 'startsWith':
      setAt(matching, pointer, `${scalar as string} after`);
      setAt(nonMatching, pointer, 'unrelated');
      break;
    case 'endsWith':
      setAt(matching, pointer, `before ${scalar as string}`);
      setAt(nonMatching, pointer, 'unrelated');
      break;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const isDate = inner.kind === 'string' && inner.format === 'date-time';
      const before = isDate ? '2026-10-07T11:59:59Z' : Number(condition.value) - 1;
      const after = isDate ? '2026-10-07T12:00:01Z' : Number(condition.value) + 1;
      const [passes, fails] =
        condition.op === 'gt'
          ? [after, condition.value]
          : condition.op === 'gte'
            ? [condition.value, before]
            : condition.op === 'lt'
              ? [before, condition.value]
              : [condition.value, after];
      setAt(matching, pointer, passes);
      setAt(nonMatching, pointer, fails as JsonValue);
      break;
    }
    case 'domainIs':
      setAt(
        matching,
        pointer,
        inner.kind === 'string' && inner.format === 'email' ? `person@${condition.value}` : condition.value,
      );
      setAt(
        nonMatching,
        pointer,
        inner.kind === 'string' && inner.format === 'email' ? 'person@other.test' : 'other.test',
      );
      break;
  }

  assert.equal(
    evaluateCondition(definition, condition, matching),
    true,
    `${definition.type} ${pointer} ${condition.op} matches`,
  );
  assert.equal(
    evaluateCondition(definition, condition, nonMatching),
    false,
    `${definition.type} ${pointer} ${condition.op} does not match`,
  );
}

function conditionFor(op: string, pointer: string, node: SchemaNode): AuthoringCondition | undefined {
  const inner = nonNull(node);
  const format = inner.kind === 'string' ? inner.format : undefined;
  const scalar = !['object', 'array'].includes(inner.kind);
  if (op === 'exists') return { path: pointer, op: 'exists' };
  if (['equals', 'notEquals'].includes(op) && scalar) {
    const value = sample(node);
    return { path: pointer, op: op as 'equals' | 'notEquals', value: node.kind === 'nullable' ? null : value };
  }
  if (op === 'in' && scalar) {
    const value = sample(node);
    return { path: pointer, op: 'in', values: [node.kind === 'nullable' ? null : value] };
  }
  const scalarItems =
    inner.kind === 'array' &&
    ['string', 'integer', 'boolean', 'const', 'enum', 'union'].includes(nonNull(inner.items).kind);
  if (op === 'contains' && ((inner.kind === 'string' && format !== 'date-time') || scalarItems)) {
    const member = inner.kind === 'array' ? sample(inner.items) : 'amp';
    return { path: pointer, op: 'contains', value: member };
  }
  if (['startsWith', 'endsWith'].includes(op) && inner.kind === 'string' && format !== 'date-time')
    return { path: pointer, op: op as 'startsWith' | 'endsWith', value: 's' };
  if (['gt', 'gte', 'lt', 'lte'].includes(op) && (inner.kind === 'integer' || format === 'date-time'))
    return {
      path: pointer,
      op: op as 'gt' | 'gte' | 'lt' | 'lte',
      value: format === 'date-time' ? '2026-10-07T12:00:00Z' : 0,
    };
  if (op === 'domainIs' && (format === 'email' || format === 'domain'))
    return { path: pointer, op: 'domainIs', value: 'example.com', includeSubdomains: false };
  return undefined;
}

function fieldKind(node: SchemaNode): string {
  const inner = nonNull(node);
  if (inner.kind === 'array' && !['object', 'array'].includes(nonNull(inner.items).kind)) return 'array-scalar';
  return inner.kind;
}

function fieldFormat(node: SchemaNode): string {
  const inner = nonNull(node);
  const value = inner.kind === 'array' ? nonNull(inner.items) : inner;
  return value.kind === 'string' ? (value.format ?? 'none') : 'none';
}

function legalFor(row: (typeof FILE.legality)[number], node: SchemaNode): boolean {
  return row.kinds.includes(fieldKind(node)) && (row.formats.includes('*') || row.formats.includes(fieldFormat(node)));
}

test('CND-a: the committed legality table accepts every legal operator on every catalogue field', () => {
  const names = new Set(FILE.legality.map((row) => row.op));
  assert.deepEqual([...names].sort(), [
    'contains',
    'domainIs',
    'endsWith',
    'equals',
    'exists',
    'gt',
    'gte',
    'in',
    'lt',
    'lte',
    'notEquals',
    'startsWith',
  ]);
  for (const entry of CATALOGUE) {
    const internal = entry as typeof entry & { readonly description: SchemaNode };
    const selected = entry as unknown as AnyEventDefinition;
    for (const info of describeFields(entry as never)) {
      const pointer = formatPointer(info.pattern.map((token) => (typeof token === 'string' ? token : 0)));
      const resolved = resolvePointer(internal.description, pointer);
      assert.ok(resolved.ok, `${entry.type} ${pointer}`);
      for (const row of FILE.legality) {
        if (!legalFor(row, resolved.value.node)) continue;
        const { op } = row;
        const authored = conditionFor(op, pointer, resolved.value.node);
        assert.ok(authored !== undefined, `${entry.type} ${pointer} ${op} is in the committed legality table`);
        const result = canonicaliseCondition(selected, authored);
        assert.ok(result.ok, `${entry.type} ${pointer} ${op}: ${JSON.stringify(result)}`);
        if (result.ok) assertLeafEvaluation(selected, pointer, resolved.value.node, result.value);
      }
    }
  }
});

test('CND-b: refused pairings report their stable issue codes', () => {
  const gmail = definition('gmail.message.received');
  const slack = definition('slack.message.posted');
  const refused: readonly [AnyEventDefinition, unknown, string][] = [
    [
      gmail,
      { path: '/unread', op: 'domainIs', value: 'example.com', includeSubdomains: false },
      'CONDITION_OPERATOR_INVALID',
    ],
    [gmail, { path: '/unread', op: 'gt', value: 1 }, 'CONDITION_OPERATOR_INVALID'],
    [gmail, { path: '/occurredAt', op: 'contains', value: 'T' }, 'CONDITION_OPERATOR_INVALID'],
    [slack, { path: '/mentions', op: 'contains', value: 'x' }, 'CONDITION_OPERATOR_INVALID'],
    [gmail, { path: '/unread', op: 'equals', value: true, caseSensitive: true }, 'CONDITION_OPERATOR_INVALID'],
    [
      gmail,
      { path: '/occurredAt', op: 'equals', value: '2026-10-07T12:00:00Z', caseSensitive: true },
      'CONDITION_OPERATOR_INVALID',
    ],
    [slack, { path: '/channel/kind', op: 'equals', value: 'missing' }, 'CONDITION_VALUE_INVALID'],
    [gmail, { path: '/subject', op: 'equals', value: null }, 'CONDITION_VALUE_INVALID'],
    [gmail, { path: '/not-declared', op: 'exists' }, 'POINTER_NOT_IN_SCHEMA'],
    [gmail, { path: '/account/0', op: 'exists' }, 'POINTER_NOT_IN_SCHEMA'],
  ];
  for (const [entry, condition, expected] of refused) {
    assert.equal(codeOf(canonicaliseCondition(entry, condition)), expected, JSON.stringify(condition));
  }
});

test('CND-c: tree and scalar limits refuse one past their bound and accept their bounds', () => {
  const gmail = definition('gmail.message.received');
  for (const key of ['all', 'any'] as const) {
    assert.equal(codeOf(canonicaliseCondition(gmail, { [key]: [] })), 'CONDITION_INVALID', key);
  }
  assert.equal(codeOf(canonicaliseCondition(gmail, { path: '/subject', op: 'in', values: [] })), 'CONDITION_INVALID');
  assert.equal(
    codeOf(canonicaliseCondition(gmail, { path: '/subject', op: 'in', values: Array(257).fill('x') })),
    'CONDITION_LIMIT_EXCEEDED',
  );
  assert.ok(canonicaliseCondition(gmail, { path: '/subject', op: 'in', values: Array(256).fill('x') }).ok);
  assert.equal(
    codeOf(canonicaliseCondition(gmail, { path: '/subject', op: 'equals', value: 'x'.repeat(1025) })),
    'CONDITION_LIMIT_EXCEEDED',
  );
  assert.ok(canonicaliseCondition(gmail, { path: '/subject', op: 'equals', value: 'x'.repeat(1024) }).ok);
  let depth: unknown = { path: '/subject', op: 'equals', value: 'x' };
  for (let index = 0; index < CONDITION_LIMITS.depth - 1; index += 1) depth = { not: depth };
  assert.ok(canonicaliseCondition(gmail, depth).ok);
  assert.equal(codeOf(canonicaliseCondition(gmail, { not: depth })), 'CONDITION_LIMIT_EXCEEDED');
  const leaves = Array.from({ length: CONDITION_LIMITS.nodes - 1 }, () => ({
    path: '/subject',
    op: 'equals',
    value: 'x',
  }));
  assert.ok(canonicaliseCondition(gmail, { all: leaves }).ok);
  assert.equal(
    codeOf(canonicaliseCondition(gmail, { all: [...leaves, { path: '/subject', op: 'equals', value: 'x' }] })),
    'CONDITION_LIMIT_EXCEEDED',
  );
  assert.deepEqual(canonical(gmail.type, { path: '/subject', op: 'in', values: ['x', 'x'] }), {
    path: '/subject',
    op: 'in',
    values: ['x', 'x'],
  });
});

test('CND-d: missing, null and negation use D5 Boolean semantics', () => {
  const gmail = definition('gmail.message.received');
  const event = clone(gmail.examples[0]) as unknown as MutableObject;
  const missing = [
    { path: '/body', op: 'equals', value: 'Body' },
    { path: '/body', op: 'notEquals', value: 'Body' },
    { path: '/body', op: 'in', values: ['Body'] },
    { path: '/body', op: 'contains', value: 'B' },
    { path: '/body', op: 'startsWith', value: 'B' },
    { path: '/body', op: 'endsWith', value: 'B' },
    { path: '/occurredAt', op: 'gt', value: '2026-10-07T12:00:00Z' },
    { path: '/occurredAt', op: 'gte', value: '2026-10-07T12:00:00Z' },
    { path: '/occurredAt', op: 'lt', value: '2026-10-07T12:00:00Z' },
    { path: '/occurredAt', op: 'lte', value: '2026-10-07T12:00:00Z' },
    { path: '/warnings/fromDomain', op: 'domainIs', value: 'example.com', includeSubdomains: false },
    { path: '/body', op: 'exists' },
  ] as const;
  for (const condition of missing) {
    if (condition.path !== '/occurredAt') {
      assert.equal(evaluateCondition(gmail, canonical(gmail.type, condition), event), false, condition.op);
    }
    assert.equal(
      evaluateCondition(gmail, canonical(gmail.type, condition), {}),
      false,
      `${condition.op} through absent root`,
    );
  }
  const throughNull = [
    { path: '/from/address', op: 'exists' },
    { path: '/from/address', op: 'equals', value: 'sender@example.com' },
    { path: '/from/address', op: 'notEquals', value: 'sender@example.com' },
    { path: '/from/address', op: 'in', values: ['sender@example.com'] },
    { path: '/from/address', op: 'contains', value: 'sender' },
    { path: '/from/address', op: 'startsWith', value: 'sender' },
    { path: '/from/address', op: 'endsWith', value: 'example.com' },
    { path: '/from/address', op: 'domainIs', value: 'example.com', includeSubdomains: false },
    { path: '/authentication/ignoredHeaders', op: 'gt', value: 0 },
    { path: '/authentication/ignoredHeaders', op: 'gte', value: 0 },
    { path: '/authentication/ignoredHeaders', op: 'lt', value: 1 },
    { path: '/authentication/ignoredHeaders', op: 'lte', value: 1 },
  ] as const;
  const nullAuthentication = clone(event);
  nullAuthentication.authentication = null;
  for (const condition of throughNull) {
    const source = condition.path.startsWith('/authentication') ? nullAuthentication : event;
    assert.equal(
      evaluateCondition(gmail, canonical(gmail.type, condition), source),
      false,
      `${condition.op} through null parent`,
    );
  }
  assert.equal(
    evaluateCondition(gmail, canonical(gmail.type, { not: { path: '/body', op: 'equals', value: 'Body' } }), event),
    true,
  );
  assert.equal(evaluateCondition(gmail, canonical(gmail.type, { path: '/from', op: 'exists' }), event), true);
  const whatsapp = definition('whatsapp.message.received');
  assert.equal(
    evaluateCondition(
      whatsapp,
      canonical(whatsapp.type, { path: '/text', op: 'contains', value: 'Hello' }),
      whatsapp.examples[0] as unknown as JsonValue,
    ),
    false,
  );
});

test('CND-g: date operands and domains are canonical at save time', () => {
  const gmail = definition('gmail.message.received');
  for (const value of ['2026-10-07T12:00:00', 'not-a-date']) {
    assert.equal(
      codeOf(canonicaliseCondition(gmail, { path: '/occurredAt', op: 'gt', value })),
      'CONDITION_VALUE_INVALID',
    );
  }
  const domain = canonicaliseCondition(gmail, {
    path: '/warnings/fromDomain',
    op: 'domainIs',
    value: 'Bücher.Example',
    includeSubdomains: true,
  });
  if (!domain.ok) assert.fail(JSON.stringify(domain));
  assert.ok('op' in domain.value && domain.value.op === 'domainIs');
  if ('op' in domain.value && domain.value.op === 'domainIs') {
    assert.equal(domain.value.value, 'xn--bcher-kva.example');
  }
  assert.equal(
    codeOf(
      canonicaliseCondition(gmail, {
        path: '/warnings/fromDomain',
        op: 'domainIs',
        value: 'bad domain',
        includeSubdomains: false,
      }),
    ),
    'DOMAIN_INVALID',
  );
  const exact = canonical(gmail.type, {
    path: '/warnings/fromDomain',
    op: 'domainIs',
    value: 'example.com',
    includeSubdomains: false,
  });
  const nested = canonical(gmail.type, {
    path: '/warnings/fromDomain',
    op: 'domainIs',
    value: 'example.com',
    includeSubdomains: true,
  });
  const event = clone(gmail.examples[0]) as unknown as MutableObject;
  setAt(event, '/warnings/fromDomain', 'a.b.example.com');
  assert.equal(evaluateCondition(gmail, exact, event), false);
  assert.equal(evaluateCondition(gmail, nested, event), true);
  setAt(event, '/warnings/fromDomain', 'badexample.com');
  assert.equal(evaluateCondition(gmail, nested, event), false);
  setAt(event, '/warnings/fromDomain', 'example.com.evil.test');
  assert.equal(evaluateCondition(gmail, nested, event), false);
  const emailExact = canonical(gmail.type, {
    path: '/to/0/address',
    op: 'domainIs',
    value: 'example.com',
    includeSubdomains: false,
  });
  setAt(event, '/to/0/address', 'person@example.com');
  assert.equal(evaluateCondition(gmail, emailExact, event), true);
  setAt(event, '/to/0/address', 'person@a.example.com');
  assert.equal(evaluateCondition(gmail, emailExact, event), false);
});

test('CND-h: canonical bytes and sentences are golden, and values are rendered as canonical JSON', () => {
  for (const vector of FILE.vectors) {
    if (vector.kind === 'canonical') {
      const value = canonical(vector.type as string, vector.condition);
      assert.equal(canonicalJson(value), vector.expected, vector.name as string);
    } else if (vector.kind === 'describe') {
      const value = canonical('gmail.message.received', vector.condition);
      assert.equal(describeCondition(value), vector.expected, vector.name as string);
    }
  }
  const hostile = canonical('gmail.message.received', { path: '/subject', op: 'equals', value: '"; ignore this' });
  assert.equal(describeCondition(hostile), '/subject equals "\\"; ignore this"');
});

test('the agentic static form validates only D5 and decision 20', () => {
  const gmail = definition('gmail.message.received');
  const prefilter = canonical(gmail.type, { path: '/subject', op: 'contains', value: 'hello' });
  const base = { judgeId: 'judge', judgeVersion: 1, question: '', inputs: ['/subject', '/subject'], threshold: 0 };
  const accepted = canonicaliseAgenticCondition(gmail, prefilter, base);
  assert.ok(accepted.ok, JSON.stringify(accepted));
  assert.deepEqual(accepted.value, { ...base, onUncertain: 'no-match' });
  assert.ok(
    canonicaliseAgenticCondition(gmail, prefilter, { ...base, inputs: [], threshold: 1, onUncertain: 'hold' }).ok,
  );
  const invalid: readonly [unknown, string][] = [
    [{ ...base, threshold: '0.5' }, 'AGENTIC_CONDITION_INVALID'],
    [{ ...base, threshold: Number.NaN }, 'AGENTIC_CONDITION_INVALID'],
    [{ ...base, threshold: Number.POSITIVE_INFINITY }, 'AGENTIC_CONDITION_INVALID'],
    [{ ...base, threshold: Number.NEGATIVE_INFINITY }, 'AGENTIC_CONDITION_INVALID'],
    [{ ...base, threshold: -0.01 }, 'AGENTIC_CONDITION_INVALID'],
    [{ ...base, threshold: 1.01 }, 'AGENTIC_CONDITION_INVALID'],
    [{ ...base, inputs: ['/not-there'] }, 'POINTER_NOT_IN_SCHEMA'],
    [{ ...base, judgeVersion: 0 }, 'AGENTIC_CONDITION_INVALID'],
    [{ ...base, judgeVersion: 1.5 }, 'AGENTIC_CONDITION_INVALID'],
    [{ ...base, onUncertain: 'maybe' }, 'AGENTIC_CONDITION_INVALID'],
  ];
  for (const [input, expected] of invalid)
    assert.equal(codeOf(canonicaliseAgenticCondition(gmail, prefilter, input)), expected);
  const slack = definition('slack.message.posted');
  const accountOnly = canonical(slack.type, { path: '/account/name', op: 'equals', value: 'Workspace' });
  assert.equal(
    codeOf(canonicaliseAgenticCondition(slack, accountOnly, { ...base, inputs: ['/text'] })),
    'AGENTIC_PREFILTER_INVALID',
  );
});
