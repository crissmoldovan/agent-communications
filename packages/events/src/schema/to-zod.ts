/**
 * A schema description compiled to Zod (events phase A plan, decision 5): the schema an `EventDefinition` carries
 * (D3), which must accept and refuse exactly what the JSON Schema compiled from the same description does — ajv holds
 * it to that in the tests — and, beyond it, check the one named invariant a description carries, `sorted`.
 *
 * Where Zod's own checks would differ from JSON Schema's, they are not used:
 * - lengths are counted in code points, as JSON Schema counts them (A.1), not in Zod's UTF-16 code units;
 * - an integer is any JSON number that is a whole number, as `multipleOf: 1` says, not Zod's safe-integer `int()`;
 *   and the remainder is not Zod's `multipleOf`, which takes some fractions for whole numbers;
 * - duplicates are found by JSON equality — canonical JSON — as `uniqueItems` finds them.
 *
 * Objects are strict, every property not marked optional is required, and formats are checked by the function the
 * caller gives: the catalogue's own formats, or a stand-in in tests.
 */
import { z } from 'zod';
import { canonicalJson } from '../json.ts';
import { codePointLength, compareUtf8 } from '../text.ts';
import { checkDescription, type SchemaFormat, type SchemaNode } from './describe.ts';

export interface ZodCompileOptions {
  /** Whether `value` is in the semantic format `format`. */
  readonly checkFormat: (format: SchemaFormat, value: string) => boolean;
}

/** `node` as a Zod schema. Throws `EventsError` (`SCHEMA_DESCRIPTION_INVALID`) for a description it refuses. */
export function toZod(node: SchemaNode, options: ZodCompileOptions): z.ZodType {
  checkDescription(node);
  return compile(node, options);
}

/**
 * A refusal Zod reports beside its own checks, naming in `params.keyword` the JSON Schema keyword that refuses the
 * value too — or, for `sorted-utf8`, the named invariant no keyword states.
 */
const issue = (input: unknown, keyword: string, message: string) => ({
  code: 'custom' as const,
  input,
  message,
  params: { keyword },
});

function compile(node: SchemaNode, options: ZodCompileOptions): z.ZodType {
  switch (node.kind) {
    case 'string': {
      const { minLength, maxLength, pattern, format } = node;
      const base = pattern === undefined ? z.string() : z.string().regex(pattern);
      if (minLength === undefined && maxLength === undefined && format === undefined) return base;
      return base.check((context) => {
        const length = minLength === undefined && maxLength === undefined ? 0 : codePointLength(context.value);
        if (minLength !== undefined && length < minLength) {
          context.issues.push(issue(context.value, 'minLength', `fewer than ${minLength} code points`));
        }
        if (maxLength !== undefined && length > maxLength) {
          context.issues.push(issue(context.value, 'maxLength', `more than ${maxLength} code points`));
        }
        if (format !== undefined && !options.checkFormat(format, context.value)) {
          context.issues.push(issue(context.value, 'format', `not a valid ${format}`));
        }
      });
    }
    case 'integer': {
      const { minimum } = node;
      return z.number().check((context) => {
        if (!Number.isInteger(context.value)) {
          context.issues.push(issue(context.value, 'multipleOf', 'not a whole number'));
        }
        if (minimum !== undefined && context.value < minimum) {
          context.issues.push(issue(context.value, 'minimum', `less than ${minimum}`));
        }
      });
    }
    case 'boolean':
      return z.boolean();
    case 'const':
      return z.literal(node.value);
    case 'enum':
      return z.enum(node.values as [string, ...string[]]);
    case 'union':
      return z.union(node.of.map((member) => compile(member, options)));
    case 'nullable':
      return compile(node.of, options).nullable();
    case 'array': {
      const { uniqueItems, sorted } = node;
      const base = z.array(compile(node.items, options));
      if (uniqueItems === undefined && sorted === undefined) return base;
      return base.check((context) => {
        const items = context.value;
        if (uniqueItems === true) {
          const seen = new Set<string>();
          for (const item of items) {
            const text = canonicalJson(item);
            if (seen.has(text)) {
              context.issues.push(issue(items, 'uniqueItems', `holds ${text} more than once`));
              break;
            }
            seen.add(text);
          }
        }
        if (sorted === true) {
          for (let index = 1; index < items.length; index += 1) {
            if (compareUtf8(items[index - 1] as string, items[index] as string) > 0) {
              context.issues.push(issue(items, 'sorted-utf8', `is not in raw UTF-8 order at index ${index}`));
              break;
            }
          }
        }
      });
    }
    case 'object': {
      const shape = Object.fromEntries(
        Object.entries(node.properties).map(([key, property]) => [
          key,
          property.kind === 'optional' ? compile(property.of, options).optional() : compile(property, options),
        ]),
      );
      const base = z.strictObject(shape);
      const { dependentRequired } = node;
      if (dependentRequired === undefined) return base;
      return base.check((context) => {
        const value = context.value as Readonly<Record<string, unknown>>;
        const present = (key: string) => Object.hasOwn(value, key) && value[key] !== undefined;
        for (const [key, needs] of Object.entries(dependentRequired)) {
          if (!present(key)) continue;
          for (const name of needs) {
            if (!present(name)) {
              context.issues.push({
                ...issue(value, 'dependentRequired', `${key} is present without ${name}`),
                path: [name],
              });
            }
          }
        }
      });
    }
  }
}
