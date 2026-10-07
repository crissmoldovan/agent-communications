import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyRepresentation,
  CATALOGUE,
  checkMappedSize,
  classifyMapped,
  compileMapping,
  deliverySchema,
  deliverySchemaId,
  EventsError,
  evaluateMapping,
} from '../src/index.ts';
import { ajvOracle } from './support/schema-oracle.ts';

const gmail = CATALOGUE[0];
const slack = CATALOGUE[3];
if (gmail === undefined || slack === undefined) throw new Error('catalogue examples are unavailable');

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('a catalogue example is unavailable');
  return value;
}

function compiled(definition: (typeof CATALOGUE)[number], template: unknown) {
  const result = compileMapping(definition, template);
  assert.equal(result.ok, true, result.ok ? '' : result.issues.map((issue) => issue.message).join('; '));
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

test('MAP-a and MAP-d: templates copy clean typed values, deep-clone them, and apply every missing policy', () => {
  const event = required(gmail.examples[0]);
  const mapping = compiled(gmail, {
    constant: { nested: ['value'] },
    root: { $path: '' },
    address: { $path: '/messageId' },
    optionalNull: { $path: '/body', missing: 'null' },
    optionalOmit: { $path: '/body', missing: 'omit' },
    array: [{ $path: '/subject' }, { $path: '/body', missing: 'null' }],
    $type: 'ordinary output key',
  });
  const mapped = evaluateMapping(mapping, event);
  assert.deepEqual(mapped.data, {
    constant: { nested: ['value'] },
    root: event,
    address: event.messageId,
    optionalNull: null,
    array: [event.subject, null],
    $type: 'ordinary output key',
  });
  assert.equal(Object.hasOwn(mapped.data as object, 'optionalOmit'), false);
  const root = mapped.data as unknown as { root: { labels: string[] } };
  root.root.labels.push('MUTATED');
  assert.equal(event.labels.includes('MUTATED'), false, 'a copied object has no alias to the source event');

  for (const [template, pointer] of [
    [{ $path: '/body', missing: 'omit' }, ''],
    [[{ $path: '/body', missing: 'omit' }], '/0'],
  ] as const) {
    const result = compileMapping(gmail, template);
    assert.equal(result.ok, false, JSON.stringify(template));
    if (!result.ok) assert.equal(result.issues[0]?.pointer, pointer);
  }
  for (const template of [
    { $path: '/subject', extra: true },
    { $path: '/not-declared' },
    { $path: '/subject', missing: 'unknown' },
  ]) {
    assert.equal(compileMapping(gmail, template).ok, false, JSON.stringify(template));
  }
  assert.throws(() => evaluateMapping(compiled(gmail, { $path: '/body' }), event), EventsError);
});

test('MAP-a: mapping limits count leaves, canonical constant bytes, and mapped bytes at their exact bounds', () => {
  const leaves = Array.from({ length: 200 }, (_, index) => ({ [`v${index}`]: index })).reduce(
    (object, entry) => Object.assign(object, entry),
    {},
  );
  assert.equal(compileMapping(gmail, leaves).ok, true);
  assert.equal(compileMapping(gmail, { ...leaves, tooMany: true }).ok, false);
  assert.equal(compileMapping(gmail, 'x'.repeat(4094)).ok, true, 'the JSON string consumes two quote bytes');
  assert.equal(compileMapping(gmail, 'x'.repeat(4095)).ok, false);
  assert.doesNotThrow(() => checkMappedSize('x'.repeat(262_142)));
  assert.throws(() => checkMappedSize('x'.repeat(262_143)), EventsError);
});

test('MAP-e and TNT-a: provenance expands copied parents and classifies untrusted prose, addresses, and scoped handles', () => {
  const event = required(gmail.examples[1]);
  const mapped = evaluateMapping(
    compiled(gmail, { from: { $path: '/from' }, to: { $path: '/to' }, first: { $path: '/to/0' } }),
    event,
  );
  assert.deepEqual(
    mapped.provenance.filter((entry) => entry.kind === 'source').map((entry) => [entry.output, entry.source]),
    [
      ['/from', '/from'],
      ['/from/address', '/from/address'],
      ['/from/name', '/from/name'],
      ['/to', '/to'],
      ['/to/0', '/to/0'],
      ['/to/0/address', '/to/0/address'],
      ['/to/0/name', '/to/0/name'],
      ['/first', '/to/0'],
      ['/first/address', '/to/0/address'],
      ['/first/name', '/to/0/name'],
    ],
  );
  const rootCopy = evaluateMapping(compiled(gmail, { copy: { $path: '' } }), event);
  assert.ok(
    rootCopy.provenance.some((entry) => entry.kind === 'source' && entry.output === '/copy' && entry.source === ''),
  );
  const classified = classifyMapped(gmail, event, mapped);
  assert.deepEqual(
    classified.addresses.map((entry) => entry.pointer),
    ['/from/address', '/to/0/address', '/first/address'],
  );
  const rootClassified = classifyMapped(gmail, event, rootCopy);
  assert.ok(
    rootClassified.untrusted.some((entry) => entry.pointer === '/copy/subject' && entry.text === event.subject),
  );
  const nullEvent = required(gmail.examples[0]);
  const nullCopy = evaluateMapping(compiled(gmail, { copy: { $path: '' } }), nullEvent);
  const nullClassified = classifyMapped(gmail, nullEvent, nullCopy);
  assert.equal(
    nullClassified.untrusted.some((entry) => entry.pointer === '/copy/from/name'),
    false,
    'K1 null is never untrusted',
  );

  const slackEvent = required(slack.examples[1]);
  const slackMapped = evaluateMapping(
    compiled(slack, { author: { $path: '/author' }, mentions: { $path: '/mentions' } }),
    slackEvent,
  );
  const slackClassified = classifyMapped(slack, slackEvent, slackMapped);
  assert.ok(slackClassified.handles.length > 0);
  assert.ok(slackClassified.handles.every((handle) => handle.workspace === slackEvent.workspaceId));
});

test('MAP-b: representations replace exactly classified untrusted strings and never a null or structured address', () => {
  const event = required(gmail.examples[1]);
  const mapped = evaluateMapping(compiled(gmail, { subject: { $path: '/subject' }, from: { $path: '/from' } }), event);
  const classified = classifyMapped(gmail, event, mapped);
  assert.deepEqual(applyRepresentation(mapped.data, classified, { kind: 'plain' }), mapped.data);
  const enveloped = applyRepresentation(mapped.data, classified, {
    kind: 'enveloped',
    envelope: (text, pointer) => `<test pointer="${pointer}">${text}</test>`,
  }) as { subject: string; from: { address: string; name: string | null } | null };
  assert.match(enveloped.subject, /^<test pointer="\/subject">/u);
  assert.equal(enveloped.from?.address, event.from?.address);
  assert.match(enveloped.from?.name ?? '', /^<test pointer="\/from\/name">/u);
  const nullEvent = required(gmail.examples[0]);
  const nullMapped = evaluateMapping(compiled(gmail, { $path: '/body', missing: 'null' }), nullEvent);
  assert.equal(
    applyRepresentation(nullMapped.data, classifyMapped(gmail, nullEvent, nullMapped), {
      kind: 'enveloped',
      envelope: (text) => `<test>${text}</test>`,
    }),
    null,
  );
});

test('MAP-c and D3-c: delivery schemas describe actual representations and delivery ids percent-encode components', () => {
  const mapping = compiled(gmail, {
    subject: { $path: '/subject' },
    sender: { $path: '/from' },
    pair: [{ $path: '/messageId' }, { $path: '/body', missing: 'null' }],
    omitted: { $path: '/body', missing: 'omit' },
  });
  const plain = deliverySchema(gmail, mapping, { kind: 'plain' }, 'rule:1/é', 1, 'target @,😀', 2);
  const enveloped = deliverySchema(
    gmail,
    mapping,
    { kind: 'enveloped', envelope: () => '' },
    'rule:1/é',
    1,
    'target @,😀',
    2,
  );
  assert.equal(plain.$id, 'urn:agentcomms:schema:delivery:rule%3A1%2F%C3%A9:v1:target%20%40%2C%F0%9F%98%80:v2');
  assert.equal(enveloped.$id, plain.$id);
  assert.deepEqual((plain.properties as Record<string, unknown>).pair, {
    type: 'array',
    prefixItems: [
      { type: 'string', minLength: 1 },
      { anyOf: [{ type: 'string', 'x-agentcomms-untrusted': 'plain' }, { type: 'null' }] },
    ],
    items: false,
    minItems: 2,
    maxItems: 2,
  });
  assert.deepEqual((enveloped.properties as Record<string, unknown>).subject, {
    type: 'string',
    'x-agentcomms-untrusted': 'enveloped',
  });
  assert.equal((enveloped.required as readonly string[]).includes('omitted'), false);
  const source = required(gmail.examples[0]);
  const mapped = evaluateMapping(mapping, source);
  const classified = classifyMapped(gmail, source, mapped);
  const represented = applyRepresentation(mapped.data, classified, { kind: 'plain' });
  assert.equal(ajvOracle().compile(plain)(represented), true);
  assert.equal(
    deliverySchemaId('rule:1/é', 1, 'target @,😀', 2),
    'urn:agentcomms:schema:delivery:rule%3A1%2F%C3%A9:v1:target%20%40%2C%F0%9F%98%80:v2',
  );
});

test('MAP-a: an output key named __proto__ is an own property in the mapped data and the delivery schema (code review r1)', () => {
  const event = required(gmail.examples[0]);
  // JSON.parse makes `__proto__` an own key, as a template read from JSON is.
  const template = JSON.parse('{"__proto__":{"$path":"/warnings"},"subject":{"$path":"/subject"}}');
  const mapping = compiled(gmail, template);
  const mapped = evaluateMapping(mapping, event);
  const data = mapped.data as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(data), Object.prototype, 'the prototype is untouched');
  assert.equal(Object.hasOwn(data, '__proto__'), true, 'an own property, not the prototype setter');
  assert.deepEqual(Object.keys(data).sort(), ['__proto__', 'subject']);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(data, '__proto__')?.value,
    (event as { warnings: unknown }).warnings,
    'the copied value',
  );
  const schema = deliverySchema(gmail, mapping, { kind: 'plain' } as never, 'rul_1', 1, 'tgt_1', 1) as {
    properties: Record<string, unknown>;
    required: string[];
  };
  assert.equal(Object.hasOwn(schema.properties, '__proto__'), true, 'the schema names the key as a property');
  assert.ok(schema.required.includes('__proto__'));
});
