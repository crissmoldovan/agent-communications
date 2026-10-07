/**
 * The constraint record (events phase A plan, Task 10), and a reader that turns a decision-6 JSON Schema into records.
 *
 * A record describes one field position of one catalogue type: its path, written as an RFC 6901 pointer with `*` for
 * "any array item" (`""` is the top-level object); whether it is optional and nullable; its kind; and the constraints
 * of that kind. Two readings of Appendix A are compared as records: the extractor's (`extract.ts`, from the spec's
 * text) and the hand transcription's (`test/fixtures/catalogue-v1.json`, read here). Task 11 reads its generated
 * schema with the same reader, so all three are compared constraint by constraint rather than as text.
 *
 * This is test code. It imports nothing from the library, so a bug there cannot be reproduced on both sides.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The kinds decision 6 writes: `const` and `enum` have their own, and a nullable node is its kind plus `nullable`. */
export type Kind = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'const' | 'enum' | 'anyOf';

/** One branch of a non-null `anyOf`: a scalar kind and its constraints. */
export interface Branch {
  kind: Kind;
  const?: Json;
  enum?: string[];
  pattern?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  multipleOf?: number;
}

/** One field position. Lengths count code points (A.1). */
export interface FieldRecord extends Branch {
  optional: boolean;
  nullable: boolean;
  /** For `anyOf`: its branches, in order. */
  branches?: Branch[];
  /** For an array: `uniqueItems`, and the named invariant `sorted-utf8` (decision 7). */
  uniqueItems?: boolean;
  sortedUtf8?: boolean;
  /** For an object. */
  additionalProperties?: false;
  dependentRequired?: Record<string, string[]>;
}

export type PatternToken = string | { any: true };
export type Pattern = PatternToken[];

/** D3's five metadata lists, in Appendix A's order. */
export interface Metadata {
  untrusted: Pattern[];
  content: Pattern[];
  addresses: Pattern[];
  handles: { pattern: Pattern; workspace: Pattern }[];
  formats: { pattern: Pattern; format: string }[];
}

/** Decision 7's closed vocabulary of named invariants. */
export const PATTERN_RULES: readonly string[] = ['sorted-utf8'];
export const POINTER_RULES: readonly string[] = [
  'same-instant',
  'identical',
  'slack-ts-instant',
  'non-empty-either',
  'disjoint',
  'length-equals',
  'differs',
  'whatsapp-message-key',
];

export type Invariant = { rule: string; pattern: Pattern } | { rule: string; pointers: string[] };

/** How `subject` or `dedupeKey` is computed (Task 10's descriptors). */
export type DescriptorPart = string | { pointer: string } | { staging: string };
export type Descriptor =
  | { pointer: string }
  | { join: string; pointers: string[] }
  | { canonicalJson: DescriptorPart[] };

/** Everything one reading says about one catalogue type. */
export interface RecordSet {
  type: string;
  records: Record<string, FieldRecord>;
  metadata: Metadata;
  invariants: Invariant[];
  subject: Descriptor;
  dedupeKey: Descriptor;
}

/** One entry of the transcription fixture. */
export interface TranscriptionEntry {
  type: string;
  schema: { [key: string]: Json };
  metadata: Metadata;
  invariants: Invariant[];
  subject: Descriptor;
  dedupeKey: Descriptor;
}

export interface Transcription {
  description: string;
  types: TranscriptionEntry[];
}

/** What A.1 says every root carries: the `$schema` URI and the `$id` template. */
export interface RootGrammar {
  schemaUri: string;
  idTemplate: string;
}

/** A position for messages: the root is named, not left blank. */
export function show(path: string): string {
  return path === '' ? '(root)' : path;
}

/** JSON with every object's keys sorted, so equal values print equally; `undefined` prints as "absent". */
export function stable(value: unknown): string {
  if (value === undefined) return 'absent';
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value;
}

/** One step of a record path: RFC 6901 escaping, with `*` for an array item. */
export function step(key: string): string {
  return `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

/** The record path a metadata pattern names. */
export function patternPath(pattern: Pattern): string {
  return pattern.map((token) => (typeof token === 'string' ? step(token) : '/*')).join('');
}

function isObject(value: unknown): value is { [key: string]: Json } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNullNode(value: unknown): boolean {
  return isObject(value) && Object.keys(value).length === 1 && value.type === 'null';
}

function onlyKeys(node: { [key: string]: Json }, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) {
      throw new Error(`${show(path)}: the schema uses "${key}" here, which this reading of decision 6 does not write`);
    }
  }
}

function count(node: { [key: string]: Json }, key: string, path: string): number | undefined {
  const value = node[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new Error(`${show(path)}: "${key}" is not a number`);
  return value;
}

function text(node: { [key: string]: Json }, key: string, path: string): string | undefined {
  const value = node[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${show(path)}: "${key}" is not a string`);
  return value;
}

/** The kind and constraints of a non-null node. Objects and arrays are walked by `readNode`. */
function summary(node: { [key: string]: Json }, path: string, root: boolean): Branch & Partial<FieldRecord> {
  if ('const' in node) {
    onlyKeys(node, ['const'], path);
    return { kind: 'const', const: node.const as Json };
  }
  if ('anyOf' in node) {
    onlyKeys(node, ['anyOf'], path);
    const branches = node.anyOf;
    if (!Array.isArray(branches) || branches.length < 2) throw new Error(`${show(path)}: "anyOf" needs two branches`);
    return { kind: 'anyOf', branches: branches.map((branch, index) => readBranch(branch, `${path}/anyOf/${index}`)) };
  }
  const strings = (): Branch => {
    const out: Branch = { kind: 'string' };
    const pattern = text(node, 'pattern', path);
    const format = text(node, 'format', path);
    const minLength = count(node, 'minLength', path);
    const maxLength = count(node, 'maxLength', path);
    if (pattern !== undefined) out.pattern = pattern;
    if (format !== undefined) out.format = format;
    if (minLength !== undefined) out.minLength = minLength;
    if (maxLength !== undefined) out.maxLength = maxLength;
    return out;
  };
  switch (node.type) {
    case 'string': {
      onlyKeys(node, ['type', 'minLength', 'maxLength', 'pattern', 'format', 'enum'], path);
      const out = strings();
      if (node.enum !== undefined) {
        const members = node.enum;
        if (!Array.isArray(members) || !members.every((member) => typeof member === 'string')) {
          throw new Error(`${show(path)}: "enum" is not a list of strings`);
        }
        out.kind = 'enum';
        out.enum = members as string[];
      }
      return out;
    }
    case 'number': {
      onlyKeys(node, ['type', 'multipleOf', 'minimum'], path);
      const out: Branch = { kind: 'number' };
      const multipleOf = count(node, 'multipleOf', path);
      const minimum = count(node, 'minimum', path);
      if (multipleOf !== undefined) out.multipleOf = multipleOf;
      if (minimum !== undefined) out.minimum = minimum;
      return out;
    }
    case 'boolean':
      onlyKeys(node, ['type'], path);
      return { kind: 'boolean' };
    case 'array':
      onlyKeys(node, ['type', 'items', 'uniqueItems'], path);
      return { kind: 'array', uniqueItems: node.uniqueItems === true, sortedUtf8: false };
    case 'object': {
      onlyKeys(
        node,
        [
          'type',
          'properties',
          'required',
          'additionalProperties',
          'dependentRequired',
          ...(root ? ['$schema', '$id'] : []),
        ],
        path,
      );
      const out: Branch & Partial<FieldRecord> = { kind: 'object' };
      if (node.additionalProperties === false) out.additionalProperties = false;
      if (node.dependentRequired !== undefined) {
        const dependent = node.dependentRequired;
        if (!isObject(dependent)) throw new Error(`${show(path)}: "dependentRequired" is not an object`);
        out.dependentRequired = dependent as Record<string, string[]>;
      }
      return out;
    }
    default:
      throw new Error(`${show(path)}: the type ${JSON.stringify(node.type)} is not one decision 6 writes`);
  }
}

function readBranch(branch: Json, path: string): Branch {
  if (!isObject(branch)) throw new Error(`${show(path)}: a schema node must be an object`);
  const read = summary(branch, path, false);
  if (read.kind === 'object' || read.kind === 'array' || read.kind === 'anyOf') {
    throw new Error(`${show(path)}: an anyOf branch here must be a scalar`);
  }
  return read;
}

function readNode(node: Json, path: string, optional: boolean, out: Record<string, FieldRecord>): void {
  if (!isObject(node)) throw new Error(`${show(path)}: a schema node must be an object`);
  let nullable = false;
  let inner = node;
  if (Array.isArray(node.anyOf) && node.anyOf.some(isNullNode)) {
    onlyKeys(node, ['anyOf'], path);
    const [first, second] = node.anyOf;
    if (node.anyOf.length !== 2 || !isNullNode(second) || !isObject(first)) {
      throw new Error(`${show(path)}: a nullable node is written anyOf [ <T>, { "type": "null" } ]`);
    }
    nullable = true;
    inner = first;
  }
  if (inner.type === 'null') throw new Error(`${show(path)}: "null" appears outside a nullable anyOf`);
  out[path] = { optional, nullable, ...summary(inner, path, path === '') };
  if (inner.type === 'object') {
    const properties = inner.properties ?? {};
    if (!isObject(properties)) throw new Error(`${show(path)}: "properties" is not an object`);
    const required = inner.required ?? [];
    if (!Array.isArray(required) || !required.every((name) => typeof name === 'string')) {
      throw new Error(`${show(path)}: "required" is not a list of names`);
    }
    for (const name of required) {
      if (!(name in properties)) throw new Error(`${show(path)}: "required" names ${name}, which is not a property`);
    }
    for (const [name, child] of Object.entries(properties)) {
      readNode(child, path + step(name), !required.includes(name), out);
    }
  }
  if (inner.type === 'array') {
    if (inner.items === undefined) throw new Error(`${show(path)}: an array without "items"`);
    readNode(inner.items, `${path}/*`, false, out);
  }
}

/** Every field position of a decision-6 JSON Schema, as records. `sorted-utf8` comes from the named invariants. */
export function readSchema(schema: Json, invariants: readonly Invariant[] = []): Record<string, FieldRecord> {
  const records: Record<string, FieldRecord> = {};
  readNode(schema, '', false, records);
  for (const invariant of invariants) {
    if (invariant.rule !== 'sorted-utf8' || !('pattern' in invariant)) continue;
    const path = patternPath(invariant.pattern);
    const record = records[path];
    if (record?.kind !== 'array') {
      throw new Error(`sorted-utf8 names ${show(path)}, which is not an array position of the schema`);
    }
    record.sortedUtf8 = true;
  }
  return records;
}

/** A transcription entry, read into the same record set the extractor produces. */
export function readTranscription(entry: TranscriptionEntry): RecordSet {
  return {
    type: entry.type,
    records: readSchema(entry.schema, entry.invariants),
    metadata: entry.metadata,
    invariants: entry.invariants,
    subject: entry.subject,
    dedupeKey: entry.dedupeKey,
  };
}

const METADATA_LISTS = ['untrusted', 'content', 'addresses', 'handles', 'formats'] as const;

/**
 * Every difference between two readings, each naming the type, the path and the constraint. Records and metadata are
 * compared exactly (metadata in Appendix A's order); invariants as a set, since their order states nothing.
 */
export function compareRecordSets(extracted: readonly RecordSet[], transcribed: readonly RecordSet[]): string[] {
  const differences: string[] = [];
  const names = (sets: readonly RecordSet[]): string[] => sets.map((set) => set.type);
  if (stable(names(extracted)) !== stable(names(transcribed))) {
    differences.push(
      `the types differ: the extraction has ${stable(names(extracted))}, the transcription ${stable(names(transcribed))}`,
    );
  }
  for (const want of extracted) {
    const have = transcribed.find((set) => set.type === want.type);
    if (!have) continue;
    const type = want.type;
    const paths = [...new Set([...Object.keys(want.records), ...Object.keys(have.records)])].sort();
    for (const path of paths) {
      const a = want.records[path];
      const b = have.records[path];
      if (!b) {
        differences.push(`${type} ${show(path)}: in the extraction, missing from the transcription`);
        continue;
      }
      if (!a) {
        differences.push(`${type} ${show(path)}: in the transcription, not in the extraction`);
        continue;
      }
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const key of keys) {
        const left = stable((a as unknown as Record<string, unknown>)[key]);
        const right = stable((b as unknown as Record<string, unknown>)[key]);
        if (left !== right) {
          differences.push(`${type} ${show(path)}: ${key} is ${right} in the transcription, ${left} in the extraction`);
        }
      }
    }
    for (const list of METADATA_LISTS) {
      const a = want.metadata[list] as unknown[];
      const b = (have.metadata?.[list] ?? []) as unknown[];
      for (let index = 0; index < Math.max(a.length, b.length); index++) {
        if (stable(a[index]) !== stable(b[index])) {
          differences.push(
            `${type} metadata ${list}[${index}]: ${stable(b[index])} in the transcription, ${stable(a[index])} in the extraction`,
          );
          break;
        }
      }
    }
    const left = want.invariants.map(stable).sort();
    const right = (have.invariants ?? []).map(stable).sort();
    for (const invariant of left.filter((item) => !right.includes(item))) {
      differences.push(`${type} invariant ${invariant}: in the extraction, missing from the transcription`);
    }
    for (const invariant of right.filter((item) => !left.includes(item))) {
      differences.push(`${type} invariant ${invariant}: in the transcription, not in the extraction`);
    }
    for (const key of ['subject', 'dedupeKey'] as const) {
      if (stable(want[key]) !== stable(have[key])) {
        differences.push(
          `${type} ${key}: ${stable(have[key])} in the transcription, ${stable(want[key])} in the extraction`,
        );
      }
    }
  }
  return differences;
}

function utf8Order(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

const FORBIDDEN = ['$ref', '$defs', 'definitions', 'title', 'description', '$comment', 'examples', 'default'];

/**
 * Where a transcription entry departs from decision 6's shape: inline nodes only, strict objects with a sorted and
 * present `required`, integers as `number` with `multipleOf: 1`, nullables as `anyOf`, literals without `type`,
 * enums with `type: "string"`, and A.1's exact `$schema` and `$id`.
 */
export function decisionSixProblems(entry: TranscriptionEntry, grammar: RootGrammar): string[] {
  const problems: string[] = [];
  const keys = Object.keys(entry).sort();
  const expectedKeys = ['dedupeKey', 'invariants', 'metadata', 'schema', 'subject', 'type'];
  if (stable(keys) !== stable(expectedKeys)) problems.push(`the entry's keys are ${stable(keys)}`);
  const root = entry.schema;
  if (root.$schema !== grammar.schemaUri) problems.push(`$schema is ${stable(root.$schema)}`);
  const id = grammar.idTemplate.replace('<catalogue-type>', entry.type);
  if (root.$id !== id) problems.push(`$id is ${stable(root.$id)}, not ${id}`);
  if (root.type !== 'object') problems.push('the root is not an object');

  const walk = (node: Json, path: string, nullBranch: boolean): void => {
    if (!isObject(node)) {
      problems.push(`${show(path)}: a schema node is not an object`);
      return;
    }
    for (const key of FORBIDDEN) if (key in node) problems.push(`${show(path)}: "${key}" is not written inline-only`);
    if ('dependentRequired' in node && path !== '') problems.push(`${show(path)}: dependentRequired below the root`);
    if (Array.isArray(node.type)) problems.push(`${show(path)}: a type list; a nullable is written as anyOf`);
    if (node.type === 'integer') problems.push(`${show(path)}: "integer"; decision 6 writes number with multipleOf 1`);
    if (node.type === 'null' && !nullBranch) problems.push(`${show(path)}: "null" outside a nullable anyOf`);
    if (node.type === 'number' && node.multipleOf !== 1) problems.push(`${show(path)}: a number without multipleOf 1`);
    if ('const' in node && 'type' in node) problems.push(`${show(path)}: a literal carries "type"`);
    if ('enum' in node && node.type !== 'string') problems.push(`${show(path)}: an enum without type "string"`);
    if ('uniqueItems' in node && node.uniqueItems !== true) problems.push(`${show(path)}: uniqueItems is not true`);
    if (node.type === 'object') {
      if (node.additionalProperties !== false)
        problems.push(`${show(path)}: an object without additionalProperties false`);
      if (!isObject(node.properties)) problems.push(`${show(path)}: an object without properties`);
      const required = node.required;
      if (!Array.isArray(required)) {
        problems.push(`${show(path)}: an object without "required"`);
      } else {
        const names = required.filter((name): name is string => typeof name === 'string');
        const sorted = [...new Set(names)].sort(utf8Order);
        if (names.length !== required.length || stable(names) !== stable(sorted)) {
          problems.push(`${show(path)}: "required" is not sorted by UTF-8 bytes without repeats: ${stable(required)}`);
        }
      }
      for (const [name, child] of Object.entries(isObject(node.properties) ? node.properties : {})) {
        walk(child, path + step(name), false);
      }
    }
    if (node.type === 'array') walk(node.items ?? null, `${path}/*`, false);
    if (Array.isArray(node.anyOf)) {
      const nulls = node.anyOf.filter(isNullNode).length;
      if (nulls > 0 && (node.anyOf.length !== 2 || !isNullNode(node.anyOf[1]))) {
        problems.push(`${show(path)}: a nullable anyOf is not [ <T>, { "type": "null" } ]`);
      }
      node.anyOf.forEach((branch, index) => {
        walk(branch, `${path}/anyOf/${index}`, isNullNode(branch));
      });
    }
  };
  walk(root, '', false);
  return problems;
}
