/**
 * Unicode Normalization Form C, from the bundled Unicode 15.1 tables alone (events phase A plan, decision 2).
 *
 * Not `String.prototype.normalize`, which follows the host's ICU: Node and every webview have their own Unicode
 * version, and a character assigned after 15.1 would normalise differently in each. This is UAX #15's algorithm over
 * the pinned data: full canonical decomposition, canonical ordering, then canonical composition, where
 * Full_Composition_Exclusion is never composed and Hangul syllables are decomposed and composed arithmetically. It is
 * held to every line of Unicode's own NormalizationTest.txt for 15.1.
 */

import {
  canonicalDecomposition,
  canonicalDecompositions,
  combiningClass,
  isCompositionExcluded,
} from '../../vendor/unicode-15.1.0/generated/normalization.ts';
import { codePoints, fromCodePoints } from './codepoints.ts';

// Hangul syllables, by the arithmetic of the Unicode Standard, §3.12.
const S_BASE = 0xac00;
const L_BASE = 0x1100;
const V_BASE = 0x1161;
const T_BASE = 0x11a7;
const L_COUNT = 19;
const V_COUNT = 21;
const T_COUNT = 28;
const N_COUNT = V_COUNT * T_COUNT;
const S_COUNT = L_COUNT * N_COUNT;

/** Appends the full canonical decomposition of `point` to `into`. */
function decompose(point: number, into: number[]): void {
  const syllable = point - S_BASE;
  if (syllable >= 0 && syllable < S_COUNT) {
    into.push(L_BASE + Math.floor(syllable / N_COUNT), V_BASE + Math.floor((syllable % N_COUNT) / T_COUNT));
    const trailing = syllable % T_COUNT;
    if (trailing !== 0) into.push(T_BASE + trailing);
    return;
  }
  const mapping = canonicalDecomposition(point);
  if (mapping === undefined) {
    into.push(point);
    return;
  }
  for (const part of mapping) decompose(part, into);
}

/** Puts every run of non-starters into canonical order: by combining class, stably. */
function reorder(points: number[]): void {
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i] as number;
    const ccc = combiningClass(point);
    if (ccc === 0) continue;
    let j = i;
    while (j > 0 && combiningClass(points[j - 1] as number) > ccc) {
      points[j] = points[j - 1] as number;
      j -= 1;
    }
    points[j] = point;
  }
}

/** The primary composites: every two-code-point canonical decomposition that is not excluded, by its pair. */
let composites: Map<number, number> | undefined;
const pairKey = (first: number, second: number) => first * 0x110000 + second;

/** The primary composite of `first` followed by `second`, or `undefined`. */
function compose(first: number, second: number): number | undefined {
  const leading = first - L_BASE;
  if (leading >= 0 && leading < L_COUNT) {
    const vowel = second - V_BASE;
    if (vowel >= 0 && vowel < V_COUNT) return S_BASE + (leading * V_COUNT + vowel) * T_COUNT;
    return undefined;
  }
  const syllable = first - S_BASE;
  if (syllable >= 0 && syllable < S_COUNT && syllable % T_COUNT === 0) {
    const trailing = second - T_BASE;
    if (trailing > 0 && trailing < T_COUNT) return first + trailing;
    return undefined;
  }
  if (composites === undefined) {
    composites = new Map();
    for (const [point, mapping] of canonicalDecompositions()) {
      if (mapping.length === 2 && !isCompositionExcluded(point)) {
        composites.set(pairKey(mapping[0] as number, mapping[1] as number), point);
      }
    }
  }
  return composites.get(pairKey(first, second));
}

/** Canonical composition, in place of `points`, which are decomposed and in canonical order. */
function composeAll(points: readonly number[]): number[] {
  const out: number[] = [];
  let starter = -1;
  let lastClass = 0;
  for (const point of points) {
    const ccc = combiningClass(point);
    // Not blocked from the last starter: nothing stands between them, or everything between has a lower class.
    const adjacent = starter === out.length - 1;
    if (starter !== -1 && (adjacent || (lastClass !== 0 && lastClass < ccc))) {
      const composite = compose(out[starter] as number, point);
      if (composite !== undefined) {
        out[starter] = composite;
        continue;
      }
    }
    if (ccc === 0) starter = out.length;
    out.push(point);
    lastClass = ccc;
  }
  return out;
}

/** `text` in Unicode Normalization Form C, by Unicode 15.1, whatever the host's Unicode version. */
export function nfc(text: string): string {
  let ascii = true;
  for (let i = 0; i < text.length && ascii; i += 1) ascii = text.charCodeAt(i) < 0x80;
  if (ascii) return text;
  const decomposed: number[] = [];
  for (const point of codePoints(text)) decompose(point, decomposed);
  reorder(decomposed);
  return fromCodePoints(composeAll(decomposed));
}
