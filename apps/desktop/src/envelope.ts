/**
 * The CLI's untrusted-content envelope, read so the app can mark what a sender wrote (DA4, DA11). Core writes it in
 * `wrapUntrusted` (`packages/core/src/untrusted.ts`):
 *
 *     <untrusted-content boundary="<b>" field="…" …>\n<content>\n</untrusted-content boundary="<b>">
 *
 * The boundary is random per response, and core defuses anything in the content shaped like the tag, so content
 * cannot close its own envelope. Here an envelope is only an opening tag of that shape, with a boundary, and the first
 * closing tag after it with the same boundary: a closing tag with another boundary closes nothing, and an opening tag
 * with no matching close is not an envelope, so its text shows as it came. Nothing here makes markup: the parts are
 * strings, and the screen shows each as text.
 */

export type EnvelopePart = { kind: 'text'; text: string } | { kind: 'outside'; text: string };

/** An attribute value core writes: `ATTRIBUTE_SAFE` in `untrusted.ts`. */
const VALUE = '[A-Za-z0-9._:@/-]{1,128}';
const OPENING = new RegExp(`<untrusted-content((?: [a-z][a-z-]*="${VALUE}")+)>\\n`, 'g');
const BOUNDARY = new RegExp(`^ boundary="(${VALUE})"`);

/** The text, split into what the CLI wrote and what each envelope holds, in order. */
export function splitEnvelopes(text: string): EnvelopePart[] {
  const parts: EnvelopePart[] = [];
  let shown = 0;
  OPENING.lastIndex = 0;
  for (let match = OPENING.exec(text); match !== null; match = OPENING.exec(text)) {
    // Core writes the boundary first.
    const boundary = BOUNDARY.exec(match[1] ?? '')?.[1];
    if (boundary === undefined) continue;
    const start = match.index + match[0].length;
    const closing = `\n</untrusted-content boundary="${boundary}">`;
    const end = text.indexOf(closing, start);
    if (end === -1) continue;
    if (match.index > shown) parts.push({ kind: 'text', text: text.slice(shown, match.index) });
    parts.push({ kind: 'outside', text: text.slice(start, end) });
    shown = end + closing.length;
    OPENING.lastIndex = shown;
  }
  if (shown < text.length || parts.length === 0) parts.push({ kind: 'text', text: text.slice(shown) });
  return parts;
}
