/**
 * Punycode (RFC 3492), the encoding of a Unicode label's code points as an ASCII string, as IDNA uses it: base 36,
 * tmin 1, tmax 26, skew 38, damp 700, initial bias 72, initial n 128, and `-` as the delimiter. Written here, rather
 * than taken from a host, so that Node and a webview encode and decode alike.
 */

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 0x80;
const DELIMITER = 0x2d;
/** The largest integer the arithmetic may reach, as RFC 3492's reference implementation's 32-bit one does. */
const MAX_INT = 0x7fffffff;

/** RFC 3492, §6.1. */
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

/** The digit a code point stands for — `a`–`z` (either case) are 0–25 and `0`–`9` are 26–35 — or -1. */
function digitOf(point: number): number {
  if (point >= 0x30 && point <= 0x39) return point - 0x30 + 26;
  if (point >= 0x41 && point <= 0x5a) return point - 0x41;
  if (point >= 0x61 && point <= 0x7a) return point - 0x61;
  return -1;
}

/** The lower-case code point for a digit, 0–35. */
const digitPoint = (digit: number): number => (digit < 26 ? 0x61 + digit : 0x30 + digit - 26);

const threshold = (k: number, bias: number): number => (k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias);

/**
 * The code points `input` decodes to, or `undefined` when it is not valid Punycode: a non-basic code point before the
 * last delimiter, a character that is no digit, input that ends inside a number, arithmetic past 2^31 − 1, or a
 * decoded value that is basic, a surrogate or beyond U+10FFFF.
 */
export function decodePunycode(input: readonly number[]): number[] | undefined {
  const delimiter = input.lastIndexOf(DELIMITER);
  const output: number[] = [];
  for (let at = 0; at < Math.max(delimiter, 0); at += 1) {
    const point = input[at] as number;
    if (point >= 0x80) return undefined;
    output.push(point);
  }
  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;
  for (let at = delimiter > 0 ? delimiter + 1 : 0; at < input.length; ) {
    const old = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (at >= input.length) return undefined;
      const digit = digitOf(input[at] as number);
      at += 1;
      if (digit === -1) return undefined;
      if (digit > Math.floor((MAX_INT - i) / w)) return undefined;
      i += digit * w;
      const t = threshold(k, bias);
      if (digit < t) break;
      if (w > Math.floor(MAX_INT / (BASE - t))) return undefined;
      w *= BASE - t;
    }
    const length = output.length + 1;
    bias = adapt(i - old, length, old === 0);
    if (Math.floor(i / length) > MAX_INT - n) return undefined;
    n += Math.floor(i / length);
    i %= length;
    if (n < 0x80 || (n >= 0xd800 && n <= 0xdfff) || n > 0x10ffff) return undefined;
    output.splice(i, 0, n);
    i += 1;
  }
  return output;
}

/** The Punycode of `input`'s code points, or `undefined` when the arithmetic would pass 2^31 − 1. */
export function encodePunycode(input: readonly number[]): number[] | undefined {
  const output: number[] = input.filter((point) => point < 0x80);
  const basic = output.length;
  if (basic > 0) output.push(DELIMITER);
  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;
  for (let handled = basic; handled < input.length; ) {
    let m = MAX_INT;
    for (const point of input) if (point >= n && point < m) m = point;
    if (m - n > Math.floor((MAX_INT - delta) / (handled + 1))) return undefined;
    delta += (m - n) * (handled + 1);
    n = m;
    for (const point of input) {
      if (point < n) {
        delta += 1;
        if (delta > MAX_INT) return undefined;
      }
      if (point === n) {
        let q = delta;
        for (let k = BASE; ; k += BASE) {
          const t = threshold(k, bias);
          if (q < t) break;
          output.push(digitPoint(t + ((q - t) % (BASE - t))));
          q = Math.floor((q - t) / (BASE - t));
        }
        output.push(digitPoint(q));
        bias = adapt(delta, handled + 1, handled === basic);
        delta = 0;
        handled += 1;
      }
    }
    delta += 1;
    n += 1;
  }
  return output;
}
