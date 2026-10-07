/**
 * The canonical domain: one spelling for every domain a condition or an address may name (events phase A plan,
 * decision 13; design D5).
 */

import type { Result } from '../result.ts';
import { uts46ToAscii } from './uts46.ts';

const PROFILE =
  'UTS #46 revision 31 ToASCII (Unicode 15.1; nontransitional, UseSTD3ASCIIRules, CheckHyphens, CheckBidi, CheckJoiners, VerifyDnsLength)';

/**
 * `input` as a canonical IDNA-ASCII domain: UTS #46 revision 31 ToASCII exactly as D5 specifies it, and then no
 * trailing root dot, so `example.com.` is not a second spelling of `example.com`.
 *
 * A refusal is one `DOMAIN_INVALID` issue per reason. Where ToASCII itself fails, the issue's `detail` is the set of
 * UTS #46 status codes it recorded (`B1`, `V6`, `A4_2` and the rest, as IdnaTestV2.txt names them); a root label that
 * ToASCII accepts is refused with `detail` `['ROOT_LABEL']`. The input is never echoed into a message.
 */
export function toAsciiDomain(input: string): Result<string> {
  const outcome = uts46ToAscii(input);
  const issues: { code: 'DOMAIN_INVALID'; message: string; detail: readonly string[] }[] = [];
  if (outcome.errors.length > 0) {
    issues.push({
      code: 'DOMAIN_INVALID',
      message: `the domain fails ${PROFILE}: ${outcome.errors.join(', ')}`,
      detail: outcome.errors,
    });
  }
  if (outcome.rootLabel) {
    issues.push({
      code: 'DOMAIN_INVALID',
      message: 'the domain ends in a root dot; a canonical domain is written without it',
      detail: ['ROOT_LABEL'],
    });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: outcome.ascii };
}
