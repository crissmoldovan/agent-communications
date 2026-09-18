/**
 * One renderer for every surface a send preview is shown on — the chat, an elicitation form, a terminal. Text the
 * draft's author controls (body, subject, display names, file names, link text) must not be able to change how the
 * rest of the preview reads: an ESC/CSI sequence in a body can move a terminal cursor and overwrite the To line the
 * human is about to approve; a bidi override can reverse an address; a zero-width character can hide a difference.
 */

function isUnsafeForDisplay(codePoint: number): boolean {
  if (codePoint === 0x0a || codePoint === 0x09) return false;
  if (codePoint < 0x20 || codePoint === 0x7f) return true; // C0 controls (ESC included) and DEL
  if (codePoint >= 0x80 && codePoint <= 0x9f) return true; // C1 controls (CSI included)
  if (codePoint === 0x00ad || codePoint === 0x034f || codePoint === 0x061c) return true;
  if (codePoint >= 0x200b && codePoint <= 0x200f) return true; // zero-width and directional marks
  if (codePoint === 0x2028 || codePoint === 0x2029) return true; // line and paragraph separators
  if (codePoint >= 0x202a && codePoint <= 0x202e) return true; // bidi embeddings and overrides
  if (codePoint >= 0x2060 && codePoint <= 0x206f) return true; // word joiner, bidi isolates
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return true; // variation selectors
  if (codePoint === 0xfeff) return true;
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return true; // Unicode tag characters
  return false;
}

function visible(codePoint: number): string {
  return `<U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}>`;
}

/** Makes every control and invisible character visible as `<U+XXXX>`. Newlines and tabs are kept; CRLF becomes LF. */
export function escapeForDisplay(text: string): string {
  let out = '';
  const normalised = text.replace(/\r\n/g, '\n');
  for (const char of normalised) {
    const codePoint = char.codePointAt(0) ?? 0;
    out += isUnsafeForDisplay(codePoint) ? visible(codePoint) : char;
  }
  return out;
}

/** Escapes, flattens to one line, and cuts to `width` characters — for names and file names in fixed columns. */
export function truncateDisplay(text: string, width: number): string {
  const flat = escapeForDisplay(text).replace(/[\n\t]+/g, ' ');
  const chars = [...flat];
  return chars.length <= width ? flat : `${chars.slice(0, Math.max(0, width - 1)).join('')}…`;
}

/** A Markdown code fence longer than any backtick run inside `body`, so the body cannot close it. */
export function fenceFor(body: string): string {
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((match) => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** The body as it goes into a chat preview: escaped and fenced. */
export function renderFencedBody(body: string, info = 'text'): string {
  const safe = escapeForDisplay(body);
  const fence = fenceFor(safe);
  return `${fence}${info}\n${safe}\n${fence}`;
}
