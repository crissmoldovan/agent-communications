/**
 * Text as Unicode counts and orders it, independent of the host. JSON Schema counts code points, UTF-8 sorts by code
 * point, and the wire is UTF-8 bytes, while ECMAScript strings are UTF-16 code units: these helpers bridge the two
 * without any host API, so Node, a webview and the bare realm agree.
 */

import { EventsError } from './result.ts';

const HIGH_FIRST = 0xd800;
const HIGH_LAST = 0xdbff;
const LOW_FIRST = 0xdc00;
const LOW_LAST = 0xdfff;

/**
 * The code point at `index`: a surrogate pair's, or, for a surrogate without its partner, that surrogate's own value.
 * `index` is a valid index of `text`.
 */
function codePointAt(text: string, index: number): number {
  const first = text.charCodeAt(index);
  if (first >= HIGH_FIRST && first <= HIGH_LAST && index + 1 < text.length) {
    const second = text.charCodeAt(index + 1);
    if (second >= LOW_FIRST && second <= LOW_LAST) return (first - HIGH_FIRST) * 0x400 + (second - LOW_FIRST) + 0x10000;
  }
  return first;
}

/**
 * Orders two strings by code point, which is the order of their UTF-8 bytes: negative, zero or positive.
 *
 * Not ECMAScript's `<`, which compares UTF-16 code units and so puts every astral character before U+E000–U+FFFF. A
 * surrogate without its partner sorts by its own value, between U+D7FF and U+E000, where its WTF-8 bytes would.
 */
export function compareUtf8(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = codePointAt(a, i);
    const y = codePointAt(b, j);
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

/**
 * The number of UTF-8 bytes `text` encodes to. A surrogate without its partner counts as the three bytes of the
 * replacement character an encoder writes in its place.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; ) {
    const point = codePointAt(text, i);
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    i += point > 0xffff ? 2 : 1;
  }
  return bytes;
}

/** The number of code points in `text`, as JSON Schema counts a string's length: a surrogate pair is one. */
export function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; count += 1) i += codePointAt(text, i) > 0xffff ? 2 : 1;
  return count;
}

/**
 * The UTF-8 bytes of `text`, written here rather than by a host encoder so every host writes the same ones. Throws
 * `EventsError` (`NOT_WELL_FORMED`) for a surrogate without its partner, which UTF-8 cannot encode: replacing it, as a
 * host encoder would, could make two different strings the same bytes.
 */
export function utf8Encode(text: string): Uint8Array {
  const bytes = new Uint8Array(utf8ByteLength(text));
  let at = 0;
  for (let i = 0; i < text.length; ) {
    const point = codePointAt(text, i);
    if (point >= HIGH_FIRST && point <= LOW_LAST) {
      throw new EventsError(
        'NOT_WELL_FORMED',
        `the text has an unpaired surrogate at code unit ${i}, which UTF-8 cannot encode`,
      );
    }
    if (point < 0x80) {
      bytes[at++] = point;
    } else if (point < 0x800) {
      bytes[at++] = 0xc0 | (point >> 6);
      bytes[at++] = 0x80 | (point & 0x3f);
    } else if (point < 0x10000) {
      bytes[at++] = 0xe0 | (point >> 12);
      bytes[at++] = 0x80 | ((point >> 6) & 0x3f);
      bytes[at++] = 0x80 | (point & 0x3f);
    } else {
      bytes[at++] = 0xf0 | (point >> 18);
      bytes[at++] = 0x80 | ((point >> 12) & 0x3f);
      bytes[at++] = 0x80 | ((point >> 6) & 0x3f);
      bytes[at++] = 0x80 | (point & 0x3f);
    }
    i += point > 0xffff ? 2 : 1;
  }
  return bytes;
}

/** Whether `text` is well-formed Unicode: no surrogate without its partner. */
export function isWellFormed(text: string): boolean {
  for (let i = 0; i < text.length; ) {
    const point = codePointAt(text, i);
    if (point >= HIGH_FIRST && point <= LOW_LAST) return false;
    i += point > 0xffff ? 2 : 1;
  }
  return true;
}
