import type { AnyEventDefinition } from '../catalogue/types.ts';
import type { JsonValue } from '../json.ts';
import { setOwn } from '../own-property.ts';
import { isArrayIndex, parsePointer } from '../pointer.ts';
import { EventsError } from '../result.ts';
import type { SchemaNode } from '../schema/describe.ts';
import { JSON_SCHEMA_DRAFT, type JsonSchema, toJsonSchema } from '../schema/to-json-schema.ts';
import { compareUtf8, utf8Encode } from '../text.ts';
import type { CompiledMapping, Representation } from './types.ts';

const HEX = '0123456789ABCDEF';

function percentEncodeComponent(text: string): string {
  let encoded = '';
  for (const byte of utf8Encode(text)) {
    const unreserved =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x7e;
    encoded += unreserved ? String.fromCharCode(byte) : `%${HEX[(byte >> 4) & 15]}${HEX[byte & 15]}`;
  }
  return encoded;
}

function requiredVersion(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new EventsError('MAPPING_INVALID', `${name} is a positive integer`);
  }
}

/** The D3 `$id` for one immutable rule and target version pair. */
export function deliverySchemaId(ruleId: string, ruleVersion: number, targetId: string, targetVersion: number): string {
  if (typeof ruleId !== 'string' || typeof targetId !== 'string') {
    throw new EventsError('MAPPING_INVALID', 'ruleId and targetId are strings');
  }
  requiredVersion(ruleVersion, 'ruleVersion');
  requiredVersion(targetVersion, 'targetVersion');
  return `urn:agentcomms:schema:delivery:${percentEncodeComponent(ruleId)}:v${ruleVersion}:${percentEncodeComponent(targetId)}:v${targetVersion}`;
}

type SourceToken = string | { readonly any: true };

function parseSource(pointer: string): SourceToken[] {
  const parsed = parsePointer(pointer);
  if (!parsed.ok) throw new EventsError('POINTER_MALFORMED', parsed.issues[0]?.message ?? 'not a pointer');
  return [...parsed.value];
}

function compatible(pattern: import('../pattern.ts').PointerPattern, source: readonly SourceToken[]): boolean {
  const shared = Math.min(pattern.length, source.length);
  for (let index = 0; index < shared; index += 1) {
    const left = pattern[index];
    const right = source[index];
    if (typeof left === 'string' && typeof right === 'string' && left === right) continue;
    if (typeof left !== 'string' && (typeof right !== 'string' || isArrayIndex(right))) continue;
    return false;
  }
  return true;
}

function nullable(schema: JsonSchema): JsonSchema {
  const branches = schema.anyOf;
  if (
    Array.isArray(branches) &&
    branches.some(
      (branch) => branch !== null && typeof branch === 'object' && (branch as { type?: unknown }).type === 'null',
    )
  ) {
    return schema;
  }
  return { anyOf: [schema as unknown as JsonValue, { type: 'null' }] };
}

function sourceSchema(
  node: SchemaNode,
  at: readonly SourceToken[],
  definition: AnyEventDefinition,
  representation: Representation,
): JsonSchema {
  if (node.kind === 'nullable')
    return { anyOf: [sourceSchema(node.of, at, definition, representation), { type: 'null' }] };
  if (node.kind === 'object') {
    const properties: Record<string, JsonValue> = {};
    for (const [key, property] of Object.entries(node.properties)) {
      setOwn(
        properties,
        key,
        sourceSchema(property.kind === 'optional' ? property.of : property, [...at, key], definition, representation),
      );
    }
    const required = Object.entries(node.properties)
      .filter(([, property]) => property.kind !== 'optional')
      .map(([key]) => key)
      .sort(compareUtf8);
    const result: Record<string, JsonValue> = { type: 'object', properties, required, additionalProperties: false };
    if (node.dependentRequired !== undefined) result.dependentRequired = node.dependentRequired as unknown as JsonValue;
    return result;
  }
  if (node.kind === 'array') {
    const result: Record<string, JsonValue> = {
      type: 'array',
      items: sourceSchema(node.items, [...at, { any: true }], definition, representation),
    };
    if (node.uniqueItems === true) result.uniqueItems = true;
    return result;
  }
  if (node.kind === 'string' && definition.untrusted.some((pattern) => compatible(pattern, at))) {
    if (representation.kind === 'enveloped') return { type: 'string', 'x-agentcomms-untrusted': 'enveloped' };
    return { ...toJsonSchema(node), 'x-agentcomms-untrusted': 'plain' };
  }
  return toJsonSchema(node);
}

function templateSchema(
  node: import('./types.ts').CompiledNode,
  definition: AnyEventDefinition,
  representation: Representation,
): JsonSchema {
  switch (node.kind) {
    case 'constant':
      return { const: node.value };
    case 'reference': {
      const schema = sourceSchema(node.node, parseSource(node.pointer), definition, representation);
      return node.missing === 'null' ? nullable(schema) : schema;
    }
    case 'array':
      return {
        type: 'array',
        prefixItems: node.items.map((item) => templateSchema(item, definition, representation)),
        items: false,
        minItems: node.items.length,
        maxItems: node.items.length,
      };
    case 'object': {
      const properties: Record<string, JsonValue> = {};
      const required: string[] = [];
      for (const property of node.properties) {
        setOwn(properties, property.key, templateSchema(property.node, definition, representation));
        if (!(property.node.kind === 'reference' && property.node.missing === 'omit')) required.push(property.key);
      }
      return { type: 'object', properties, required, additionalProperties: false };
    }
  }
}

/** Generate the schema for the exact selected delivery representation. */
export function deliverySchema(
  definition: AnyEventDefinition,
  mapping: CompiledMapping,
  representation: Representation,
  ruleId: string,
  ruleVersion: number,
  targetId: string,
  targetVersion: number,
): JsonSchema {
  if (mapping.definition.type !== definition.type || mapping.definition.version !== definition.version) {
    throw new EventsError('MAPPING_INVALID', 'the mapping was compiled for another event definition');
  }
  return {
    $schema: JSON_SCHEMA_DRAFT,
    $id: deliverySchemaId(ruleId, ruleVersion, targetId, targetVersion),
    ...templateSchema(mapping.root, definition, representation),
  };
}

export type { JsonSchema };
