/**
 * A domain name in the one ASCII form the behaviour rules compare it in, judged here rather than by Node (0.22.0's
 * six-platform dry run). Node's `domainToASCII` refuses `xn--a.test` on Node 22.22 and 24.15 and accepts it on a later
 * Node 24, so whether a rule naming it could be read — and whether its account allowed anything — hung on the runtime.
 * Here an ASCII name never reaches Node's URL parser, and every name, whatever converted it, passes the same checks.
 *
 * Pure: no `node:punycode` (deprecated, and it warns when loaded); RFC 3492's decoder is small enough to keep here.
 */
import { domainToASCII } from 'node:url';

/** RFC 1035: at most 253 characters without the trailing dot, and 63 in a label. */
const MAX_NAME = 253;
const MAX_LABEL = 63;
/** Letters, digits and hyphens, neither first nor last (RFC 1123), in lower case: callers lower-case first. */
const LDH_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/** The prefix of an IDNA A-label, whose rest is RFC 3492 punycode. */
const ACE_PREFIX = 'xn--';

function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) > 0x7f) return false;
  return true;
}

/**
 * `written` as an ASCII domain name, lower-cased, or null when it is not one. A name in ASCII is only lower-cased; one
 * with Unicode in it is converted by `domainToASCII` (UTS 46, so `bücher.example` and `xn--bcher-kva.example` meet), and
 * either way the result must pass `isAsciiDomainName`, so Node's verdict alone never admits a name.
 */
export function asciiDomainName(written: string): string | null {
  const ascii = (isAscii(written) ? written : domainToASCII(written)).toLowerCase();
  return isAsciiDomainName(ascii) ? ascii : null;
}

/**
 * Whether `domain` (ASCII, no trailing dot) is a domain name: at most 253 characters; each label 1–63 letters, digits
 * and hyphens, not starting or ending with a hyphen; a label starting `xn--` an A-label (`isALabel`), and any other
 * without `--` at its third and fourth characters, which IDNA reserves for such prefixes. Anything else is not one.
 */
export function isAsciiDomainName(domain: string): boolean {
  if (domain.length === 0 || domain.length > MAX_NAME) return false;
  return domain
    .toLowerCase()
    .split('.')
    .every((label) => {
      if (label.length > MAX_LABEL || !LDH_LABEL.test(label)) return false;
      if (label.startsWith(ACE_PREFIX)) return isALabel(label);
      return label.slice(2, 4) !== '--';
    });
}

/**
 * Code points no label holds even in Unicode: controls, private use, separators and format characters, but for the two
 * joiners IDNA allows in context. `xn--a` decodes to U+0080, a control — punycode, but no name.
 */
const NOT_IN_A_LABEL = /(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Co}\p{Z}]/u;

/**
 * An `xn--` label is a name only when the rest decodes as RFC 3492 punycode to a label with something outside ASCII in
 * it (else it would have been written in ASCII), unchanged by NFKC (UTS 46 maps `⒈` and its like before encoding, so
 * no A-label holds one), not starting with a combining mark, and holding none of `NOT_IN_A_LABEL`. Case is not checked:
 * UTS 46 folds Cherokee to its capitals, which a lower-case check would refuse, and an A-label is matched as written.
 */
function isALabel(label: string): boolean {
  const points = decodePunycode(label.slice(ACE_PREFIX.length));
  if (points === null || !points.some((point) => point > 0x7f)) return false;
  const unicode = String.fromCodePoint(...points);
  return unicode.normalize('NFKC') === unicode && !/^\p{M}/u.test(unicode) && !NOT_IN_A_LABEL.test(unicode);
}

/** RFC 3492's parameters for IDNA. */
const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 0x80;
/** RFC 3492 decodes in 32 bits; past this a label is refused, as overflow. */
const MAX_INT = 0x7fffffff;

/** RFC 3492 §6.1. */
function adapt(delta: number, points: number, first: boolean): number {
  let scaled = first ? Math.floor(delta / DAMP) : Math.floor(delta / 2);
  scaled += Math.floor(scaled / points);
  let k = 0;
  while (scaled > ((BASE - T_MIN) * T_MAX) >> 1) {
    scaled = Math.floor(scaled / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * scaled) / (scaled + SKEW));
}

/** A punycode digit's value — `a`–`z` 0–25, `0`–`9` 26–35, either case — or `BASE` for a character that is none. */
function digitOf(code: number): number {
  if (code >= 0x61 && code <= 0x7a) return code - 0x61;
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 26;
  return BASE;
}

/**
 * RFC 3492 §6.2: the code points `input` (punycode, without `xn--`) encodes, or null where the RFC says the decoder
 * fails — a basic part outside ASCII, a character that is no digit, input that ends inside a number, overflow — and
 * where what it decodes to is no Unicode scalar value: a basic code point encoded as a delta, a surrogate, past U+10FFFF.
 */
export function decodePunycode(input: string): number[] | null {
  const output: number[] = [];
  const delimiter = input.lastIndexOf('-');
  for (let index = 0; index < delimiter; index++) {
    const code = input.charCodeAt(index);
    if (code > 0x7f) return null;
    output.push(code);
  }
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  let i = 0;
  // The delimiter is consumed only after at least one basic code point; one at the very start is read as a digit.
  let at = delimiter > 0 ? delimiter + 1 : 0;
  while (at < input.length) {
    const before = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (at >= input.length) return null;
      const digit = digitOf(input.charCodeAt(at++));
      if (digit >= BASE || digit > Math.floor((MAX_INT - i) / w)) return null;
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      if (w > Math.floor(MAX_INT / (BASE - t))) return null;
      w *= BASE - t;
    }
    const length = output.length + 1;
    bias = adapt(i - before, length, before === 0);
    if (Math.floor(i / length) > MAX_INT - n) return null;
    n += Math.floor(i / length);
    i %= length;
    if (n <= 0x7f || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
    output.splice(i, 0, n);
    i++;
  }
  return output;
}
