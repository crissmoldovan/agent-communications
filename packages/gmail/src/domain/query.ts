/**
 * Gmail search syntax, with the one correction that matters: dates.
 *
 * `after:2026-09-17` is interpreted by the API in Pacific time, not the user's. Ask on a Wednesday morning in London
 * for "mail since yesterday" and the results quietly start eight hours late. So date operators are rewritten to
 * `after:<epoch seconds>`, which the API treats as an absolute instant, computed in the timezone the user configured.
 *
 * Everything else is passed through untouched: this is the user's query language, and rewriting more of it would be
 * guessing at intent.
 */

export interface QueryRewrite {
  operator: string;
  from: string;
  to: string;
}

export interface CompiledQuery {
  /** The query to send to Gmail. */
  compiled: string;
  /** What was changed, so a caller can show it and a user can see why results differ from the console. */
  rewrites: QueryRewrite[];
  timezone: string;
}

const DATE_OPERATORS = new Set(['after', 'before', 'older', 'newer']);

/** `YYYY/MM/DD`, `YYYY-MM-DD` and `MM/DD/YYYY`, the three forms Gmail's own help uses. */
function parseDateParts(value: string): { year: number; month: number; day: number } | null {
  const iso = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  const american = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (american) return { year: Number(american[3]), month: Number(american[1]), day: Number(american[2]) };
  return null;
}

/**
 * The UTC instant of local midnight on a date in a named timezone. Derived from the zone's own offset on that date,
 * so it stays correct across daylight saving.
 */
export function localMidnightEpochSeconds(
  parts: { year: number; month: number; day: number },
  timezone: string,
): number | null {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const read = (instant: number): number => {
      const fields = Object.fromEntries(
        formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
      );
      return Date.UTC(
        Number(fields.year),
        Number(fields.month) - 1,
        Number(fields.day),
        Number(fields.hour) % 24,
        Number(fields.minute),
        Number(fields.second),
      );
    };
    // One correction is enough for every real zone; a second settles the hour that daylight saving moves.
    let instant = guess - (read(guess) - guess);
    instant = guess - (read(instant) - instant);
    return Math.floor(instant / 1000);
  } catch {
    return null;
  }
}

/** Splits a query into tokens, keeping quoted strings, parentheses and `{}` groups intact. */
export function tokenizeQuery(query: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const character of query) {
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

export interface CompileOptions {
  /** IANA name, or `system` for this machine's zone. */
  timezone?: string | undefined;
}

export function compileQuery(query: string, options: CompileOptions = {}): CompiledQuery {
  const requested = options.timezone && options.timezone !== 'system' ? options.timezone : undefined;
  const timezone = requested ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const rewrites: QueryRewrite[] = [];

  const tokens = tokenizeQuery(query).map((token) => {
    // A leading `-` negates; the operator is what follows it.
    const negation = token.startsWith('-') ? '-' : '';
    const body = negation ? token.slice(1) : token;
    const colon = body.indexOf(':');
    if (colon <= 0) return token;
    const operator = body.slice(0, colon).toLowerCase();
    const value = body.slice(colon + 1);
    if (!DATE_OPERATORS.has(operator)) return token;
    // `older_than:7d` and `newer_than:2h` are relative and already absolute in meaning; only dates are ambiguous.
    const parts = parseDateParts(value);
    if (!parts) return token;
    const epoch = localMidnightEpochSeconds(parts, timezone);
    if (epoch === null) return token;
    rewrites.push({ operator, from: value, to: String(epoch) });
    return `${negation}${operator}:${epoch}`;
  });

  return { compiled: tokens.join(' '), rewrites, timezone };
}
