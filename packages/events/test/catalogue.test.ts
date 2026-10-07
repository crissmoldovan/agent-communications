import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CATALOGUE,
  canonicalJson,
  catalogueEntry,
  checkDefinition,
  sourceSchema,
  validateEvent,
  whatsappMessageKey,
} from '../src/index.ts';
import { checkPattern, expandPattern } from '../src/pattern.ts';
import { getPointer } from '../src/pointer.ts';
import type { SchemaNode } from '../src/schema/describe.ts';
import { applyProseRules, extractAppendix, type ProseRules } from './appendix/extract.ts';
import {
  compareRecordSets,
  type Descriptor,
  type DescriptorPart,
  type Json,
  type RecordSet,
  readSchema,
  type Transcription,
} from './appendix/records.ts';
import { ajvOracle, mutationCorpus } from './support/schema-oracle.ts';

const PACKAGE_ROOT = new URL('..', import.meta.url).pathname;
const transcription = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'test/fixtures/catalogue-v1.json'), 'utf8'),
) as Transcription;
const prose = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'test/fixtures/appendix-prose-rules.json'), 'utf8'),
) as ProseRules;
const spec = readFileSync(
  join(PACKAGE_ROOT, '../../docs/superpowers/specs/2026-10-05-local-event-emission-design.md'),
  'utf8',
);

test('CAT-a: the catalogue exposes exactly the seven Appendix A source event types', () => {
  assert.equal(CATALOGUE.length, 7);
  assert.deepEqual(
    CATALOGUE.map((definition) => definition.type),
    [
      'gmail.message.received',
      'gmail.message.sent',
      'gmail.message.labelled',
      'slack.message.posted',
      'resend.email.received',
      'resend.email.status_changed',
      'whatsapp.message.received',
    ],
  );
  for (const definition of CATALOGUE)
    assert.equal(sourceSchema(definition).$id, `urn:agentcomms:schema:source:${definition.type}:v1`);
});

test('CAT-h and CAT-i: source selection excludes operational, reset and test records', () => {
  for (const type of [
    'agentcomms.source.degraded',
    'agentcomms.source.gap',
    'agentcomms.source.recovered',
    'agentcomms.delivery.dead_lettered',
    'agentcomms.anything',
  ]) {
    const selected = catalogueEntry(type, 1);
    assert.equal(selected.ok, false, type);
    if (!selected.ok) assert.equal(selected.issues[0]?.code, 'EVENT_TYPE_NOT_SELECTABLE', type);
  }
  for (const type of ['io.agentcomms.test.v1', 'io.agentcomms.control.installation-reset.v1']) {
    const selected = catalogueEntry(type, 1);
    assert.equal(selected.ok, false, type);
    if (!selected.ok) assert.equal(selected.issues[0]?.code, 'EVENT_TYPE_UNKNOWN', type);
    assert.equal(
      CATALOGUE.some((definition) => definition.type === type),
      false,
      type,
    );
  }
  const unknown = catalogueEntry('source.unknown', 1);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.issues[0]?.code, 'EVENT_TYPE_UNKNOWN');
  const version = catalogueEntry('gmail.message.received', 2);
  assert.equal(version.ok, false);
  if (!version.ok) assert.equal(version.issues[0]?.code, 'EVENT_VERSION_UNKNOWN');
});

test('D3-a: every Appendix A subject and dedupe descriptor agrees with its definition', () => {
  for (const entry of transcription.types) {
    const definition = CATALOGUE.find((candidate) => candidate.type === entry.type);
    assert.ok(definition, entry.type);
    const callable = definition as unknown as {
      subject(event: unknown): string;
      dedupeKey(event: unknown, staging: Readonly<Record<string, string>>): string;
    };
    const staging = { historyRecordId: '42' };
    for (const event of definition.examples) {
      assert.equal(callable.subject(event), descriptor(entry.subject, event, staging), `${entry.type} subject`);
      assert.equal(
        callable.dedupeKey(event, staging),
        descriptor(entry.dedupeKey, event, staging),
        `${entry.type} key`,
      );
    }
    if (entry.type.startsWith('gmail.')) {
      assert.throws(() => callable.dedupeKey(definition.examples[0], { historyRecordId: '42.0' }));
    }
  }
  assert.equal(
    whatsappMessageKey('447700900001@s.whatsapp.net', '447700900002@s.whatsapp.net', 'stanza-1'),
    '["wa-msg","447700900001@s.whatsapp.net","447700900002@s.whatsapp.net","stanza-1"]',
  );
});

test('K2-2: WhatsApp message ids are canonical raw protocol keys tied to sender.id', () => {
  const definition = CATALOGUE[6];
  assert.ok(definition);
  const valid = whatsappMessageKey('447700900001@s.whatsapp.net', '447700900002@s.whatsapp.net', 'stanza-1');
  const event = {
    id: '0123456789abcdef0123456789abcdef',
    type: 'whatsapp.message.received',
    version: 1,
    occurredAt: '2026-10-07T12:00:00Z',
    observedAt: '2026-10-07T12:00:01Z',
    account: { name: 'Example', id: 'acc_ABCDEFGHIJKLMNOP', channel: 'whatsapp' },
    workspaceId: 'acc_ABCDEFGHIJKLMNOP',
    messageId: valid,
    chat: { id: 'display-chat', name: null, kind: 'direct' },
    sender: { id: '447700900002@s.whatsapp.net', name: null },
    text: null,
    at: '2026-10-07T12:00:00Z',
    fromMe: false,
    kind: 'text',
    viewOnce: false,
    groupEvent: null,
    media: null,
  };
  assert.equal(validateEvent(definition, event).ok, true, 'a canonical key is accepted');
  for (const messageId of [
    '["not-wa-msg","chat","447700900002@s.whatsapp.net","stanza-1"]',
    '["wa-msg","chat","","stanza-1"]',
    '[ "wa-msg", "chat", "447700900002@s.whatsapp.net", "stanza-1" ]',
    '["wa-msg","chat","someone-else","stanza-1"]',
  ]) {
    assert.equal(validateEvent(definition, { ...event, messageId }).ok, false, messageId);
  }
});

test('CAT-a and CAT-a2: every generated schema, metadata and invariant equals both Appendix A readings', () => {
  const extracted = applyProseRules(extractAppendix(spec), prose);
  const actual = CATALOGUE.map((definition) => {
    const expected = transcription.types.find((entry) => entry.type === definition.type);
    assert.ok(expected, definition.type);
    assert.equal(
      canonicalJson({
        schema: sourceSchema(definition) as unknown as Json,
        metadata: pickMetadata(definition),
        invariants: definition.invariants,
      }),
      canonicalJson({ schema: expected.schema, metadata: expected.metadata, invariants: expected.invariants }),
      definition.type,
    );
    return {
      ...expected,
      records: readSchema(sourceSchema(definition) as unknown as Json, definition.invariants as never),
      metadata: pickMetadata(definition),
      invariants: definition.invariants,
    };
  });
  assert.deepEqual(compareRecordSets(extracted.types, actual as unknown as readonly RecordSet[]), []);
});

test('CAT-b and CAT-a2: every example and every schema mutation agree with Ajv, apart from named invariants', () => {
  for (const definition of CATALOGUE) {
    const schema = sourceSchema(definition);
    const ajv = ajvOracle().compile(schema);
    for (const example of definition.examples) {
      assert.equal(validateOne(definition, example).ok, true, `${definition.type} example`);
      assert.equal(ajv(example), true, `${definition.type} Ajv example`);
      for (const mutation of mutationCorpus(
        (definition as unknown as { description: SchemaNode }).description,
        example as unknown as Json,
      )) {
        const result = validateOne(definition, mutation.value).ok;
        const oracle = ajv(mutation.value);
        if (mutation.expect === 'accepted') {
          assert.equal(result, true, `${definition.type}: ${mutation.name}`);
          assert.equal(oracle, true, `${definition.type}: ${mutation.name} (Ajv)`);
        } else if (mutation.expect === 'refused') {
          assert.equal(result, false, `${definition.type}: ${mutation.name}`);
          assert.equal(oracle, false, `${definition.type}: ${mutation.name} (Ajv)`);
        } else {
          assert.equal(result, false, `${definition.type}: ${mutation.name}`);
          assert.equal(oracle, true, `${definition.type}: ${mutation.name} (Ajv)`);
        }
      }
    }
  }
});

test('CAT-a2: every unbounded extracted scalar accepts 100000 code points', () => {
  const extracted = applyProseRules(extractAppendix(spec), prose);
  for (const entry of extracted.types) {
    const definition = CATALOGUE.find((candidate) => candidate.type === entry.type);
    assert.ok(definition, entry.type);
    const ajv = ajvOracle().compile(sourceSchema(definition));
    for (const [pointer, record] of Object.entries(entry.records)) {
      if (
        record.kind !== 'string' ||
        pointer.includes('/*') ||
        record.minLength !== undefined ||
        record.maxLength !== undefined ||
        record.pattern !== undefined ||
        record.format !== undefined
      )
        continue;
      for (const example of definition.examples) {
        const existing = getPointer(example as never, pointer);
        if (!existing.found || typeof existing.value !== 'string') continue;
        const probe = replaceAtPointer(example, pointer, '😀'.repeat(100_000));
        assert.equal(validateOne(definition, probe).ok, true, `${entry.type}: ${pointer}`);
        assert.equal(ajv(probe), true, `${entry.type}: ${pointer} (Ajv)`);
      }
    }
  }
});

test('CAT-b: named Appendix invariants reject where JSON Schema cannot', () => {
  const received = definition('gmail.message.received');
  const receivedExample = received.examples[1];
  assert.ok(receivedExample);
  assertInvariantOnly(received, { ...receivedExample, labels: ['STARRED', 'INBOX'] });
  assertInvariantOnly(received, { ...receivedExample, date: '2026-10-07T12:00:00.000001Z' });

  const labelled = definition('gmail.message.labelled');
  const labelledExample = labelled.examples[0];
  assert.ok(labelledExample);
  assertInvariantOnly(labelled, { ...labelledExample, added: [], removed: [] });
  assertInvariantOnly(labelled, { ...labelledExample, removed: ['INBOX'] });
  assertInvariantOnly(labelled, { ...labelledExample, observedAt: '2026-10-07T12:00:00.000001Z' });

  const slack = definition('slack.message.posted');
  const slackExample = slack.examples[0];
  assert.ok(slackExample);
  assertInvariantOnly(slack, { ...slackExample, occurredAt: '2023-11-14T22:13:20.123457Z' });

  const resendReceived = definition('resend.email.received');
  const resendReceivedExample = resendReceived.examples[1];
  assert.ok(resendReceivedExample);
  assertInvariantOnly(resendReceived, { ...resendReceivedExample, receivedAt: '2026-10-07T12:01:00.000001Z' });
  assertInvariantOnly(resendReceived, { ...resendReceivedExample, attachmentCount: 0 });
  assertInvariantOnly(resendReceived, {
    ...resendReceivedExample,
    attachments: [
      {
        id: 'attachment-1',
        filename: 'safe.svg',
        contentType: 'image/svg+xml',
        size: 1,
        inline: false,
        riskFlags: ['html-or-svg', 'hidden-characters-in-name'],
      },
    ],
  });

  const status = definition('resend.email.status_changed');
  const statusExample = status.examples[0];
  assert.ok(statusExample);
  assertInvariantOnly(status, { ...statusExample, current: 'queued' });

  const whatsapp = definition('whatsapp.message.received');
  const whatsappExample = whatsapp.examples[0];
  assert.ok(whatsappExample);
  assertInvariantOnly(whatsapp, { ...whatsappExample, at: '2026-10-07T12:00:00.000001Z' });
  assertInvariantOnly(whatsapp, { ...whatsappExample, workspaceId: 'acc_ZYXWVUTSRQPONMLK' });
});

test('K1 and CAT-c: metadata yields only non-null concrete scalars and every declaration fits its schema', () => {
  for (const definition of CATALOGUE) {
    checkDefinition(definition as never);
    const description = (definition as unknown as { description: SchemaNode }).description;
    const metadata = [
      ...definition.untrusted,
      ...definition.content,
      ...definition.addresses,
      ...definition.formats.map((entry) => entry.pattern),
    ];
    for (const pattern of metadata) {
      const resolved = checkPattern(description, pattern);
      assert.equal(resolved.ok, true, `${definition.type}: ${JSON.stringify(pattern)}`);
      if (resolved.ok)
        assert.equal(
          resolved.value.node.kind === 'nullable' ? resolved.value.node.of.kind : resolved.value.node.kind,
          'string',
          `${definition.type}: ${JSON.stringify(pattern)}`,
        );
      for (const example of definition.examples) {
        for (const pointer of expandPattern(pattern, example as never)) {
          const concrete = getPointer(example as never, pointer);
          assert.equal(
            concrete.found && concrete.value !== null && typeof concrete.value === 'string',
            true,
            `${definition.type}: ${pointer}`,
          );
        }
      }
    }
    for (const pattern of definition.addresses) {
      const resolved = checkPattern(description, pattern);
      assert.equal(resolved.ok, true, `${definition.type}: address ${JSON.stringify(pattern)}`);
      if (resolved.ok) {
        const node = resolved.value.node.kind === 'nullable' ? resolved.value.node.of : resolved.value.node;
        assert.equal(node.kind, 'string', `${definition.type}: address ${JSON.stringify(pattern)}`);
        if (node.kind === 'string') assert.equal(node.format, 'email', `${definition.type}: address format`);
      }
    }
    for (const handle of definition.handles) {
      const target = checkPattern(description, handle.pattern);
      const workspace = checkPattern(description, handle.workspace);
      assert.equal(target.ok, true, `${definition.type}: handle ${JSON.stringify(handle.pattern)}`);
      assert.equal(workspace.ok, true, `${definition.type}: workspace ${JSON.stringify(handle.workspace)}`);
      if (target.ok && workspace.ok) {
        const targetNode = target.value.node.kind === 'nullable' ? target.value.node.of : target.value.node;
        const workspaceNode = workspace.value.node.kind === 'nullable' ? workspace.value.node.of : workspace.value.node;
        assert.equal(targetNode.kind, 'string', `${definition.type}: handle type`);
        assert.equal(workspaceNode.kind, 'string', `${definition.type}: workspace type`);
        if (targetNode.kind === 'string')
          assert.equal(
            targetNode.minLength === 1 || (targetNode.pattern !== undefined && !targetNode.pattern.test('')),
            true,
            `${definition.type}: handle non-empty`,
          );
        if (workspaceNode.kind === 'string')
          assert.equal(
            workspaceNode.minLength === 1 || (workspaceNode.pattern !== undefined && !workspaceNode.pattern.test('')),
            true,
            `${definition.type}: workspace non-empty`,
          );
      }
      assert.equal(
        handle.workspace.some((token) => typeof token !== 'string'),
        false,
        `${definition.type}: workspace any`,
      );
    }
    const broken = {
      ...definition,
      formats: [...definition.formats, { pattern: ['not-declared'], format: 'date-time' as const }],
    };
    assert.throws(() => checkDefinition(broken as never), /not-declared/u, definition.type);
  }
});

function descriptor(descriptor: Descriptor, event: unknown, staging: Readonly<Record<string, string>>): string {
  if ('pointer' in descriptor) return descriptorPointer(event, descriptor.pointer);
  if ('join' in descriptor)
    return descriptor.pointers.map((pointer) => descriptorPointer(event, pointer)).join(descriptor.join);
  return JSON.stringify(descriptor.canonicalJson.map((part) => descriptorPart(part, event, staging)));
}

function descriptorPart(part: DescriptorPart, event: unknown, staging: Readonly<Record<string, string>>): string {
  if (typeof part === 'string') return part;
  if ('pointer' in part) return descriptorPointer(event, part.pointer);
  const found = staging[part.staging];
  if (found === undefined) throw new Error(`missing descriptor staging value ${part.staging}`);
  return found;
}

function descriptorPointer(event: unknown, pointer: string): string {
  let value = event as Record<string, unknown>;
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    const next = value[key];
    if (next === null || typeof next !== 'object') {
      if (typeof next === 'string' && token === pointer.slice(1).split('/').at(-1)) return next;
      throw new Error(`descriptor pointer ${pointer} does not name a string`);
    }
    value = next as Record<string, unknown>;
  }
  throw new Error(`descriptor pointer ${pointer} does not name a string`);
}

function replaceAtPointer(event: unknown, pointer: string, replacement: string): unknown {
  const copy = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
  const tokens = pointer
    .slice(1)
    .split('/')
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
  let at = copy;
  for (const token of tokens.slice(0, -1)) at = at[token] as Record<string, unknown>;
  const last = tokens.at(-1);
  if (last === undefined) throw new Error('a scalar probe needs a non-root pointer');
  at[last] = replacement;
  return copy;
}

function definition(type: (typeof CATALOGUE)[number]['type']): (typeof CATALOGUE)[number] {
  const found = CATALOGUE.find((candidate) => candidate.type === type);
  assert.ok(found, type);
  return found;
}

function assertInvariantOnly(definition: (typeof CATALOGUE)[number], event: unknown): void {
  assert.equal(validateOne(definition, event).ok, false, definition.type);
  assert.equal(ajvOracle().compile(sourceSchema(definition))(event), true, `${definition.type} (Ajv)`);
}

function pickMetadata(definition: (typeof CATALOGUE)[number]) {
  return {
    untrusted: definition.untrusted,
    content: definition.content,
    addresses: definition.addresses,
    handles: definition.handles,
    formats: definition.formats,
  };
}

function validateOne(definition: (typeof CATALOGUE)[number], value: unknown) {
  return validateEvent(definition as never, value);
}
