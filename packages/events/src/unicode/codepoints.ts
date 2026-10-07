/**
 * Strings as code points and back. ECMAScript strings are UTF-16 code units, while every Unicode algorithm here works
 * on code points; these two functions are the only crossing, so a surrogate pair is always read as one code point and a
 * surrogate without its partner always as its own value, passed through unchanged.
 */

const HIGH_FIRST = 0xd800;
const HIGH_LAST = 0xdbff;
const LOW_FIRST = 0xdc00;
const LOW_LAST = 0xdfff;

/** The code points of `text`, in order. A surrogate without its partner is its own value. */
export function codePoints(text: string): number[] {
  const points: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const first = text.charCodeAt(i);
    if (first >= HIGH_FIRST && first <= HIGH_LAST && i + 1 < text.length) {
      const second = text.charCodeAt(i + 1);
      if (second >= LOW_FIRST && second <= LOW_LAST) {
        points.push((first - HIGH_FIRST) * 0x400 + (second - LOW_FIRST) + 0x10000);
        i += 1;
        continue;
      }
    }
    points.push(first);
  }
  return points;
}

/** The text of a code point sequence: the inverse of `codePoints`. */
export function fromCodePoints(points: readonly number[]): string {
  let text = '';
  let units: number[] = [];
  for (const point of points) {
    if (point > 0xffff) {
      const offset = point - 0x10000;
      units.push(HIGH_FIRST + (offset >> 10), LOW_FIRST + (offset & 0x3ff));
    } else {
      units.push(point);
    }
    // In slices, so a long text never spreads more arguments than an engine accepts.
    if (units.length >= 4096) {
      text += String.fromCharCode(...units);
      units = [];
    }
  }
  return text + String.fromCharCode(...units);
}
