import { isFormat } from '../../formats/index.ts';
import type {
  ArrayNode,
  IntegerNode,
  ObjectNode,
  OptionalNode,
  SchemaNode,
  StringNode,
} from '../../schema/describe.ts';
import { toZod } from '../../schema/to-zod.ts';
import type { CatalogueEventV1, DefinitionInternal, EventDefinition } from '../types.ts';

export const ANY = { any: true } as const;
export const RISK_FLAGS = [
  'executable',
  'script',
  'macro-enabled',
  'macro-capable',
  'markup',
  'archive',
  'disk-image',
  'double-extension',
  'bidi-filename',
  'auto-read',
  'saved-as-download',
  'html-or-svg',
  'hidden-characters-in-name',
] as const;

export const string = (): StringNode => ({ kind: 'string' });
export const nonEmpty = (): StringNode => ({ kind: 'string', minLength: 1 });
export const nullableString = (): SchemaNode => ({ kind: 'nullable', of: { kind: 'string' } });
export const dateTime = (): StringNode => ({ kind: 'string', format: 'date-time' });
export const email = (): StringNode => ({ kind: 'string', format: 'email' });
export const domain = (): StringNode => ({ kind: 'string', format: 'domain' });
export const integer = (): IntegerNode => ({ kind: 'integer', minimum: 0 });
export const optional = (of: SchemaNode): OptionalNode => ({ kind: 'optional', of });
export const array = (items: SchemaNode, uniqueItems?: true, sorted?: true): ArrayNode => ({
  kind: 'array',
  items,
  ...(uniqueItems === true ? { uniqueItems } : {}),
  ...(sorted === true ? { sorted } : {}),
});

export const address = (): ObjectNode => ({
  kind: 'object',
  properties: { address: email(), name: nullableString() },
});

export const riskFlags = (): ArrayNode => array({ kind: 'enum', values: RISK_FLAGS }, true, true);

export function common(type: string, channel: string, accountPattern: RegExp): ObjectNode['properties'] {
  return {
    id: { kind: 'string', pattern: /^[0-9a-f]{32}$/u },
    type: { kind: 'const', value: type },
    version: { kind: 'const', value: 1 },
    occurredAt: dateTime(),
    observedAt: dateTime(),
    account: {
      kind: 'object',
      properties: {
        name: nonEmpty(),
        id: { kind: 'string', pattern: accountPattern },
        channel: { kind: 'const', value: channel },
      },
    },
  };
}

export function define<T extends CatalogueEventV1, S>(
  definition: Omit<DefinitionInternal<T, S>, 'schema'>,
): DefinitionInternal<T, S> {
  return {
    ...definition,
    schema: toZod(definition.description, { checkFormat: isFormat }) as EventDefinition<T, S>['schema'],
  };
}
