import type { PointerPattern } from '../pattern.ts';
import { nonNull, type SchemaNode } from '../schema/describe.ts';
import type { CatalogueEventV1, DefinitionInternal, EventDefinition } from './types.ts';

export interface FieldInfo {
  readonly pattern: PointerPattern;
  readonly kind: string;
  readonly nullable: boolean;
  readonly optional: boolean;
  readonly format?: string;
  readonly untrusted: boolean;
  readonly content: boolean;
  readonly address: boolean;
  readonly handle: boolean;
}

const same = (left: PointerPattern, right: PointerPattern) => JSON.stringify(left) === JSON.stringify(right);

/** Every scalar or array field declared by a definition, annotated by D3's metadata lists. */
export function describeFields<T extends CatalogueEventV1, S>(definition: EventDefinition<T, S>): readonly FieldInfo[] {
  const internal = definition as unknown as DefinitionInternal;
  const fields: FieldInfo[] = [];
  const visit = (node: SchemaNode, pattern: PointerPattern, optional: boolean): void => {
    const inner = nonNull(node);
    if (inner.kind === 'object') {
      for (const [key, property] of Object.entries(inner.properties))
        visit(property.kind === 'optional' ? property.of : property, [...pattern, key], property.kind === 'optional');
      return;
    }
    if (inner.kind === 'array') {
      fields.push(info(node, pattern, optional));
      visit(inner.items, [...pattern, { any: true }], false);
      return;
    }
    fields.push(info(node, pattern, optional));
  };
  const info = (node: SchemaNode, pattern: PointerPattern, optional: boolean): FieldInfo => {
    const inner = nonNull(node);
    const inList = (list: readonly PointerPattern[]) => list.some((candidate) => same(candidate, pattern));
    return {
      pattern,
      kind: inner.kind,
      nullable: node.kind === 'nullable',
      optional,
      ...(inner.kind === 'string' && inner.format !== undefined ? { format: inner.format } : {}),
      untrusted: inList(definition.untrusted),
      content: inList(definition.content),
      address: inList(definition.addresses),
      handle: definition.handles.some((entry) => same(entry.pattern, pattern)),
    };
  };
  visit(internal.description, [], false);
  return fields;
}
