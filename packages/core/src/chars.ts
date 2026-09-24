/**
 * One table of dangerous characters, shared by the inbound sanitiser (which strips them from sender-controlled text)
 * and the preview renderer (which makes them visible), so the two can never disagree.
 */

/** Zero-width and formatting characters, bidi controls, variation selectors and Unicode tag characters. */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul fillers
  [0x17b4, 0x17b5], // Khmer inherent vowels
  [0x180b, 0x180f], // Mongolian variation selectors and vowel separator
  [0x200b, 0x200f], // zero-width space/non-joiner/joiner, LRM, RLM
  [0x2028, 0x2029], // line and paragraph separators
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2060, 0x2064], // word joiner and invisible operators
  [0x2066, 0x206f], // bidi isolates and deprecated format characters
  [0x3164, 0x3164], // Hangul filler
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // zero-width no-break space / BOM
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0xe0000, 0xe007f], // Unicode tag characters
];

export function isInvisible(codePoint: number): boolean {
  for (const [from, to] of INVISIBLE_RANGES) if (codePoint >= from && codePoint <= to) return true;
  return false;
}

/**
 * C0 controls except tab and newline (ESC, and so every ANSI/OSC sequence, starts here), DEL, and C1 controls (CSI
 * among them). A lone carriage return counts: it moves a terminal cursor back over text already printed.
 */
export function isControl(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a) return false;
  return codePoint < 0x20 || codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f);
}

export function isDangerous(codePoint: number): boolean {
  return isControl(codePoint) || isInvisible(codePoint);
}

/**
 * Strips control characters (ESC, CSI, OSC and the rest), DEL, lone carriage returns, zero-width, bidi-control and tag
 * characters from sender-controlled text; returns the text and how many were removed. CRLF becomes LF first.
 *
 * This lives beside the table rather than in the sanitiser because `neutralise` needs it too, and the two must not
 * drift: a pattern that looks for `</untrusted-content` cannot see it through a zero-width space, so stripping
 * has to happen before any such pattern runs, on every path, not only on the ones that render a body.
 */
export function stripInvisible(text: string): { text: string; removed: number } {
  let removed = 0;
  let out = '';
  for (const char of text.replace(/\r\n/g, '\n')) {
    if (isDangerous(char.codePointAt(0) ?? 0)) removed += 1;
    else out += char;
  }
  return { text: out, removed };
}
