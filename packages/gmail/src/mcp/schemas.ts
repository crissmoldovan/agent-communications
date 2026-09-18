import { z } from 'zod';

/**
 * Argument shapes for the MCP tools.
 *
 * Some clients send every argument as a string, so a plain `z.boolean()` would reject calls that are really correct.
 * The fix is narrow, explicit coercion — never `z.coerce.*`, which turns `"false"` into `true` and `"abc"` into NaN,
 * silently doing the opposite of what the caller asked.
 */

/** `true`/`false` only, in either case; anything else is a validation error rather than a guess. */
export const mcpBoolean = (): z.ZodType<boolean> =>
  z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const text = value.trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
    return value;
  }, z.boolean());

/** Whole numbers only: `"12"` yes, `"12.5"` and `"twelve"` no. */
export const mcpInteger = (): z.ZodType<number> =>
  z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    return /^-?\d+$/.test(value.trim()) ? Number.parseInt(value.trim(), 10) : value;
  }, z.number().int());

/** A list of strings, or the JSON text of one. */
export const mcpStringArray = (): z.ZodType<string[]> =>
  z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : value;
    } catch {
      return value;
    }
  }, z.array(z.string()));

/** One alias, a list of aliases, or `"all"`. A bare alias is accepted as a list of one. */
export const mcpInboxes = (): z.ZodType<string[] | 'all'> =>
  z.preprocess(
    (value) => {
      if (value === 'all' || value === undefined) return value;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.startsWith('[')) {
          try {
            const parsed: unknown = JSON.parse(trimmed);
            if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed;
          } catch {
            return value;
          }
          return value;
        }
        return [trimmed];
      }
      return value;
    },
    z.union([z.literal('all'), z.array(z.string().min(1))]),
  );

/** The inbox argument every single-inbox tool takes. It is required unless the server was pinned to one inbox. */
export const inboxArgument = (pinned: boolean): z.ZodType<string | undefined> =>
  pinned
    ? z.string().min(1).optional().describe('which mailbox; this server is pinned to one, so it may be omitted')
    : z.string().min(1).describe('which mailbox, by the name it was connected under (there is no default)');
