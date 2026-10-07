import { checkPattern } from '../pattern.ts';
import { EventsError } from '../result.ts';
import { nonNull, type SchemaNode } from '../schema/describe.ts';
import type { CatalogueEventV1, DefinitionInternal, EventDefinition } from './types.ts';

const fail = (message: string): never => {
  throw new EventsError('DEFINITION_INVALID', message);
};

const nonEmptyString = (node: SchemaNode): boolean => {
  const inner = nonNull(node);
  return inner.kind === 'string' && (inner.minLength === 1 || (inner.pattern !== undefined && !inner.pattern.test('')));
};

function formatsOf(node: SchemaNode, at: string, found: Map<string, string>): void {
  const inner = nonNull(node);
  if (inner.kind === 'string' && inner.format !== undefined) found.set(at, inner.format);
  if (inner.kind === 'object') {
    for (const [key, property] of Object.entries(inner.properties)) {
      formatsOf(
        property.kind === 'optional' ? property.of : property,
        `${at}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
        found,
      );
    }
  } else if (inner.kind === 'array') {
    formatsOf(inner.items, `${at}/*`, found);
  }
}

/** Throws when a D3 declaration points outside its schema or says more than that schema declares. */
export function checkDefinition<T extends CatalogueEventV1, S>(definition: EventDefinition<T, S>): void {
  const internal = definition as unknown as DefinitionInternal;
  if (internal.description === undefined) fail(`${definition.type}: the definition has no schema description`);
  const every = [
    ...definition.untrusted,
    ...definition.content,
    ...definition.addresses,
    ...definition.formats.map((entry) => entry.pattern),
  ];
  for (const pattern of every) {
    const resolved = checkPattern(internal.description, pattern);
    if (resolved.ok) {
      if (nonNull(resolved.value.node).kind !== 'string') {
        fail(`${definition.type}: a metadata pattern does not end on a scalar string`);
      }
    } else {
      fail(`${definition.type}: ${resolved.issues[0]?.message ?? 'an invalid pattern'}`);
    }
  }
  for (const handle of definition.handles) {
    const target = checkPattern(internal.description, handle.pattern);
    const workspace = checkPattern(internal.description, handle.workspace);
    if (!target.ok || !workspace.ok) fail(`${definition.type}: a handle declaration names a path outside its schema`);
    if (!target.ok || !workspace.ok) continue;
    if (handle.workspace.some((token) => typeof token !== 'string'))
      fail(`${definition.type}: a handle workspace has an any token`);
    if (!nonEmptyString(target.value.node) || !nonEmptyString(workspace.value.node))
      fail(`${definition.type}: a handle does not end on non-null strings`);
  }
  const found = new Map<string, string>();
  formatsOf(internal.description, '', found);
  const declared = new Map(
    definition.formats.map((entry) => [
      entry.pattern
        .map((token) => (typeof token === 'string' ? `/${token.replaceAll('~', '~0').replaceAll('/', '~1')}` : '/*'))
        .join(''),
      entry.format,
    ]),
  );
  for (const [path, format] of found)
    if (declared.get(path) !== format)
      fail(`${definition.type}: ${path} has format ${format} but its metadata does not`);
  for (const [path, format] of declared)
    if (found.get(path) !== format)
      fail(`${definition.type}: metadata calls ${path} format ${format}, but the schema does not`);
}
