import type { AnyEventDefinition } from '../catalogue/types.ts';
import type { JsonValue } from '../json.ts';
import type { SchemaNode } from '../schema/describe.ts';

/** The three ways D6 handles a source path absent at evaluation time. */
export type MissingPolicy = 'reject' | 'null' | 'omit';

/** A JSON mapping template: constants, containers, and objects whose `$path` declares a reference. */
export type MappingTemplate = JsonValue;

type CompiledNode =
  | { readonly kind: 'constant'; readonly value: JsonValue }
  | { readonly kind: 'reference'; readonly pointer: string; readonly missing: MissingPolicy; readonly node: SchemaNode }
  | { readonly kind: 'object'; readonly properties: readonly { readonly key: string; readonly node: CompiledNode }[] }
  | { readonly kind: 'array'; readonly items: readonly CompiledNode[] };

/** A template checked against one catalogue definition and ready to evaluate. */
export interface CompiledMapping {
  readonly definition: AnyEventDefinition;
  readonly root: CompiledNode;
  readonly leaves: number;
}

/** One concrete output value's origin. Source origins map to their concrete source pointer. */
export type Provenance =
  | { readonly output: string; readonly kind: 'source'; readonly source: string }
  | { readonly output: string; readonly kind: 'constant' }
  | { readonly output: string; readonly kind: 'missing-null' };

/** The clean mapped JSON and all concrete origins that produced it. */
export interface MappedValue {
  readonly data: JsonValue;
  readonly provenance: readonly Provenance[];
}

/** The exact target representation selected under D3. */
export type Representation =
  | { readonly kind: 'plain' }
  | { readonly kind: 'enveloped'; readonly envelope: (text: string, pointer: string) => string };

/** A structured address copied into a target payload. */
export interface MappedAddress {
  readonly pointer: string;
  readonly address: string;
}

/** A structured platform handle copied into a target payload, together with its required workspace scope. */
export interface MappedHandle {
  readonly pointer: string;
  readonly id: string;
  readonly workspace: string;
}

/** A sender-controlled string copied into a target payload for D7's free-text taint scan. */
export interface MappedUntrusted {
  readonly pointer: string;
  readonly text: string;
}

/** Exact taint facts the daemon flushes before a target or judge disclosure. */
export interface MappedClassification {
  readonly untrusted: readonly MappedUntrusted[];
  readonly addresses: readonly MappedAddress[];
  readonly handles: readonly MappedHandle[];
}

export type { CompiledNode };
