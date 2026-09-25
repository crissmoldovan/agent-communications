import { z } from 'zod';
import { CommsError } from './errors.ts';

/**
 * Tool arguments, held to the tool's schema — every key declared, every value what it says — and refused as `USAGE`
 * in the server's own error envelope when they are not (design 2026-09-18 §11: "unknown fields are rejected").
 *
 * Why the SDK's own check is not enough. It wraps a raw shape in a plain `z.object`, which *strips* a key it does not
 * declare, and a `z.object` passed whole does the same: the call runs without the key and says nothing. That is how
 * `gmail_inbox_add {client: 'other', contacts: false}` signed in through the default client and asked for the address
 * book, back when neither was declared — and how a misspelt `readOnly`, `cc` or `threadTs` would register a server
 * that can change every mailbox, leave a copy off a draft, or put a reply in the channel instead of its thread. And
 * what it does refuse — a wrong type, a fraction, a word outside an enum, a missing argument — comes back as its
 * uncoded "Input validation error", where every other refusal a tool makes carries a code an agent can act on.
 *
 * So each tool is registered with its schema made strict, and the SDK is handed a schema that publishes exactly that
 * — the same properties, descriptions, enums and `required`, plus `additionalProperties: false`, so a client knows
 * up front — but lets every call through to a check made here, before the tool's handler, which refuses in the
 * server's own envelope. A refused call reaches nothing: no handler, no pin check, no configuration, no provider.
 *
 * The arguments themselves, not what is inside them: an object passed as one argument — `gmail_draft_send`'s
 * `expect`, `gmail_organise_undo`'s records — is handed back from another tool's answer, and every key it declares is
 * required already, so a misspelt one is refused as missing.
 */

/** What a server answers a refused call with: its own error envelope, the same as for every other refusal. */
export type RefuseToolCall = (error: CommsError) => unknown;

type Handler = (...args: unknown[]) => unknown;

/** A zod object schema, told apart without `instanceof`: a server and core may each hold their own copy of zod. */
type ObjectSchema = z.ZodObject<z.ZodRawShape>;

/** The part of JSON Schema a refusal reads to say what an argument takes. */
interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

const APPLIED = Symbol.for('agentcomms.strictToolArguments');
const TARGET = 'draft-2020-12';

/**
 * Makes every tool registered on `server` from now on refuse a key its schema does not declare, and refuse arguments
 * its schema rejects, with `refuse` — before the tool's handler runs.
 *
 * Call it once, straight after the server is constructed and before any tool is registered: it wraps the server's
 * `registerTool`, so a tool added later gets the check by being registered at all, and nobody has to remember it.
 * `refuse` is handed a `USAGE` `CommsError` and returns the tool result, so the refusal is in the same envelope as
 * every other refusal that server makes.
 */
export function strictToolArguments(server: object, refuse: RefuseToolCall): void {
  const target = server as { registerTool?: unknown; [APPLIED]?: true };
  if (typeof target.registerTool !== 'function') {
    throw new Error('strictToolArguments needs an MCP server: this has no registerTool');
  }
  if (target[APPLIED]) return;
  const register = (target.registerTool as Handler).bind(server);
  target.registerTool = (...args: unknown[]) => {
    assertToolRegistration(args);
    const [name, config, handler] = args as [string, Record<string, unknown>, Handler];
    // Without an input schema the SDK hands the handler only its context, and checks nothing. It is given one here —
    // no arguments at all — so an argument sent to it is refused too, and the handler is still called as it expects.
    const declared = config.inputSchema !== undefined;
    const schema = strictSchemaOf(name, config.inputSchema);
    const published = schema['~standard'].jsonSchema.input({ target: TARGET }) as JsonSchema;
    return register(name, { ...config, inputSchema: passThrough(schema) }, async (input: unknown, context: unknown) => {
      const parsed = await schema.safeParseAsync(input ?? {});
      if (!parsed.success) return refuse(refusal(name, published, input, parsed.error.issues));
      return declared ? handler(parsed.data, context) : handler(context);
    });
  };
  Object.defineProperty(target, APPLIED, { value: true });
}

/**
 * Throws unless a registration is `(name, config, handler)` — the shape this wraps.
 *
 * The SDK's types cannot promise it across versions: an added overload, or the handler in another position, would have
 * the wrapper check the wrong thing, and that would not crash but register a tool unchecked. So anything else stops
 * the server from starting — loud, at startup, in every test that starts one.
 */
function assertToolRegistration(args: readonly unknown[]): void {
  const [name, config, handler] = args;
  if (args.length === 3 && typeof name === 'string' && typeof config === 'object' && config !== null) {
    if (typeof handler === 'function') return;
  }
  throw new Error(
    `registerTool was called as (${args.map((arg) => (arg === null ? 'null' : typeof arg)).join(', ')}); strict tool arguments wrap (string, object, function) and cannot check this tool. Update strictToolArguments for this SDK.`,
  );
}

const isZodObject = (value: unknown): value is ObjectSchema =>
  typeof value === 'object' &&
  value !== null &&
  (value as { _zod?: { def?: { type?: unknown } } })._zod?.def?.type === 'object' &&
  typeof (value as { strict?: unknown }).strict === 'function';

const isZodSchema = (value: unknown): boolean => typeof value === 'object' && value !== null && '_zod' in value;

/** The tool's input schema, refusing any key it does not declare: a raw shape, a `z.object`, or nothing at all. */
function strictSchemaOf(tool: string, inputSchema: unknown): ObjectSchema {
  if (inputSchema === undefined) return z.strictObject({});
  if (isZodObject(inputSchema)) return inputSchema.strict();
  if (
    typeof inputSchema === 'object' &&
    inputSchema !== null &&
    !('~standard' in inputSchema) &&
    Object.values(inputSchema).every(isZodSchema)
  ) {
    return z.strictObject(inputSchema as z.ZodRawShape);
  }
  throw new Error(
    `${tool}: its input schema must be an object of named arguments — a raw zod shape or a z.object — so that a key it does not declare can be refused`,
  );
}

/**
 * What the SDK is handed: a Standard Schema that publishes the strict schema as JSON Schema, and passes every call
 * through unchanged to the check the wrapped handler makes. Validating in the SDK would refuse in its own words.
 */
function passThrough(schema: ObjectSchema): object {
  return {
    '~standard': {
      version: 1,
      vendor: 'agentcomms',
      validate: (value: unknown) => ({ value }),
      jsonSchema: schema['~standard'].jsonSchema,
    },
  };
}

// ── The refusal ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A USAGE refusal naming what was wrong and what the tool takes. */
function refusal(tool: string, published: JsonSchema, input: unknown, issues: readonly z.core.$ZodIssue[]): CommsError {
  const properties = published.properties ?? {};
  const takes = Object.keys(properties);
  const required = new Set(published.required ?? []);
  const signature =
    takes.length === 0
      ? `${tool} takes no arguments.`
      : `${tool} takes ${spoken(
          takes.map((key) => (required.has(key) ? `\`${key}\` (required)` : `\`${key}\``)),
          'and',
        )}.`;

  const unknown = issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys' && issue.path.length === 0 ? issue.keys : [],
  );
  if (unknown.length > 0) {
    return new CommsError(
      'USAGE',
      `${tool} does not take ${spoken(
        unknown.map((key) => `\`${key}\``),
        'or',
      )}`,
      {
        hint: takes.length === 0 ? signature : `${signature} Leave out anything else.`,
        details: { tool, unknown, takes },
      },
    );
  }

  const given = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const problems = new Map<string, string>();
  const general: string[] = [];
  for (const issue of issues) {
    const [key] = issue.path;
    if (typeof key !== 'string') {
      general.push(issue.message);
      continue;
    }
    if (problems.has(key)) continue;
    problems.set(key, problemWith(key, properties[key], issue, given[key] === undefined && issue.path.length === 1));
  }
  const first = [...problems.keys()][0];
  const description = first === undefined ? undefined : properties[first]?.description;
  return new CommsError('USAGE', [...problems.values(), ...general].join('; ') || `${tool} was called wrongly`, {
    hint: description ? `\`${first}\`: ${sentence(description)}` : signature,
    details: { tool, arguments: [...problems.keys()], takes },
  });
}

/** One argument's problem, in words: missing, or not what it takes — or the schema's own message, where it has one. */
function problemWith(key: string, schema: JsonSchema | undefined, issue: z.core.$ZodIssue, missing: boolean): string {
  if (missing) return `\`${key}\` is required, and takes ${what(schema)}`;
  switch (issue.code) {
    case 'invalid_type':
    case 'invalid_value':
    case 'invalid_union':
    case 'too_small':
    case 'too_big':
    case 'not_multiple_of':
      return `\`${key}\` takes ${what(schema)}`;
    default:
      // A pattern, a format or a refinement: its message is the rule, written where the schema was.
      return `\`${key}\`: ${issue.message}`;
  }
}

/** What an argument takes, from the JSON Schema a client is shown: "a whole number from 0 to 600", "`a` or `b`". */
function what(schema: JsonSchema | undefined): string {
  if (!schema) return 'a value';
  if (Array.isArray(schema.enum))
    return spoken(
      schema.enum.map((value) => `\`${String(value)}\``),
      'or',
    );
  if ('const' in schema) return `\`${String(schema.const)}\``;
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) return spoken([...new Set(alternatives.map(what))], 'or');
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'integer':
      return `a whole number${range(schema, true)}`;
    case 'number':
      return `a number${range(schema, false)}`;
    case 'boolean':
      return 'true or false';
    case 'string':
      return (schema.minLength ?? 0) > 0 ? 'a non-empty string' : 'a string';
    case 'array': {
      const item = schema.items ? what(schema.items) : '';
      return item === 'a string' || item === 'a non-empty string' ? 'a list of strings' : 'a list';
    }
    case 'object':
      return 'an object';
    case 'null':
      return 'null';
    default:
      return 'a value';
  }
}

/** A number's range, as the operations say it — "from 0 to 600", "of 1 or more" — leaving out zod's safe bounds. */
function range(schema: JsonSchema, whole: boolean): string {
  const shown = (value: number | undefined) =>
    value !== undefined && Math.abs(value) < Number.MAX_SAFE_INTEGER ? value : undefined;
  const step = whole ? 1 : 0;
  const min = shown(
    schema.minimum ?? (schema.exclusiveMinimum === undefined ? undefined : schema.exclusiveMinimum + step),
  );
  const max = shown(
    schema.maximum ?? (schema.exclusiveMaximum === undefined ? undefined : schema.exclusiveMaximum - step),
  );
  const strictBelow = !whole && schema.minimum === undefined && schema.exclusiveMinimum !== undefined;
  const strictAbove = !whole && schema.maximum === undefined && schema.exclusiveMaximum !== undefined;
  if (min !== undefined && max !== undefined && !strictBelow && !strictAbove) return ` from ${min} to ${max}`;
  const parts: string[] = [];
  if (min !== undefined) parts.push(strictBelow ? `more than ${min}` : `${min} or more`);
  if (max !== undefined) parts.push(strictAbove ? `less than ${max}` : `${max} or less`);
  return parts.length === 0 ? '' : ` of ${parts.join(' and ')}`;
}

/** A description as the end of a sentence: with a full stop, unless it already has one. */
const sentence = (text: string): string => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** `a`, `a or b`, `a, b or c`: a list as a person would say it. */
function spoken(words: readonly string[], joiner: 'and' | 'or'): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} ${joiner} ${words.at(-1)}`;
}
