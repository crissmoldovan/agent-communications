/**
 * The catalogue's semantic formats (design D3, Appendix A.1; events phase A plan, decision 10). D5 makes them
 * authoritative for conditions: `domainIs` only on `email` and `domain`, date comparison only on `date-time`, and
 * `uri` and `uuid` with no domain or date semantics.
 */

import { toAsciiDomain } from '../idna/domain.ts';
import { EventsError } from '../result.ts';
import { isEmail } from './email.ts';
import { isInstant } from './instant.ts';
import { isUri } from './uri.ts';
import { isUuid } from './uuid.ts';

export { canonicalEmail } from './email.ts';
export { compareInstants, isInstant } from './instant.ts';

/** A semantic format a catalogue string may declare. */
export type SemanticFormat = 'email' | 'domain' | 'date-time' | 'uri' | 'uuid';

/** Whether `value` is a canonical domain: one `toAsciiDomain` accepts and gives back unchanged (decision 13). */
function isDomain(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const canonical = toAsciiDomain(value);
  return canonical.ok && canonical.value === value;
}

const CHECKS: Readonly<Record<SemanticFormat, (value: unknown) => boolean>> = {
  email: isEmail,
  domain: isDomain,
  'date-time': isInstant,
  uri: isUri,
  uuid: isUuid,
};

/**
 * Whether `value` is a string in `format`. Throws `EventsError` (`FORMAT_UNKNOWN`) for a name that is not one of the
 * five formats.
 */
export function isFormat(format: SemanticFormat, value: unknown): boolean {
  const check = Object.hasOwn(CHECKS, format) ? CHECKS[format] : undefined;
  if (check === undefined)
    throw new EventsError('FORMAT_UNKNOWN', 'isFormat was given a name that is not a semantic format');
  return check(value);
}
