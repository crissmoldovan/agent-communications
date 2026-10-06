/**
 * The `email` format and the canonical address (events phase A plan, decision 12; Appendix A.1: "canonical address,
 * lower-case IDNA-ASCII domain").
 *
 * An address is `local@domain`. The local part is an RFC 5321 `Dot-string` or `Quoted-string` in ASCII, kept exactly
 * as given — its case included, because only the domain is defined to be case-insensitive — and the domain is
 * canonical: what `toAsciiDomain` makes of it is itself. An address literal (`[192.0.2.1]`) and a non-ASCII local part
 * are refused.
 */

import { toAsciiDomain } from '../idna/domain.ts';
import type { Issue, Result } from '../result.ts';

/** RFC 5322 `atext`, beside letters and digits. */
const ATEXT_MARKS = "!#$%&'*+-/=?^_`{|}~";

const isAtext = (code: number) =>
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  (code >= 0x30 && code <= 0x39) ||
  ATEXT_MARKS.includes(String.fromCharCode(code));

/** RFC 5321 `Dot-string`: one or more `Atom`s of `atext`, joined by single dots. */
function isDotString(text: string): boolean {
  return text.split('.').every((atom) => atom.length > 0 && [...atom].every((c) => isAtext(c.charCodeAt(0))));
}

/** RFC 5321 `Quoted-string`: `"`, then `qtextSMTP` (32–126 but `"` and `\`) or `\` before 32–126, then `"`. */
function isQuotedString(text: string): boolean {
  if (text.length < 2 || text[0] !== '"' || text[text.length - 1] !== '"') return false;
  for (let i = 1; i < text.length - 1; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x5c) {
      const next = text.charCodeAt(i + 1);
      if (i + 1 >= text.length - 1 || next < 0x20 || next > 0x7e) return false;
      i += 1;
    } else if (code < 0x20 || code > 0x7e || code === 0x22) {
      return false;
    }
  }
  return true;
}

/**
 * `raw` as a canonical address: the local part exactly as given, and the domain through `toAsciiDomain`. A local part
 * that is neither a Dot-string nor a Quoted-string in ASCII, or an address literal, is `FORMAT_INVALID`; a domain
 * `toAsciiDomain` refuses gives its `DOMAIN_INVALID` issues. The address is never echoed into a message.
 */
export function canonicalEmail(raw: string): Result<string> {
  const at = raw.lastIndexOf('@');
  if (at === -1) return refuse('the address has no @');
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  if (!isDotString(local) && !isQuotedString(local)) {
    return refuse('the local part is neither an RFC 5321 Dot-string nor a Quoted-string in ASCII');
  }
  if (domain.startsWith('[')) return refuse('an address literal is not a canonical address: the domain must be a name');
  const canonical = toAsciiDomain(domain);
  if (!canonical.ok) return canonical;
  return { ok: true, value: `${local}@${canonical.value}` };
}

function refuse(message: string): { ok: false; issues: readonly Issue[] } {
  return { ok: false, issues: [{ code: 'FORMAT_INVALID', message }] };
}

/** Whether `value` is a canonical address: `canonicalEmail` accepts it and gives it back unchanged. */
export function isEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const canonical = canonicalEmail(value);
  return canonical.ok && canonical.value === value;
}
