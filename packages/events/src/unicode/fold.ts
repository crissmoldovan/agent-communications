/**
 * Full Unicode 15.1 default case folding, and the form conditions compare case-insensitively (design 2026-10-05, D5).
 *
 * Folding maps each code point by CaseFolding.txt's `C` and `F` lines and nothing else: never `S`, the simple
 * alternative, and never `T`, the Turkic one, so `I` folds to `i` and `İ` to `i` and COMBINING DOT ABOVE in every
 * locale. No host case conversion is reached — a host's `toLowerCase` follows its own Unicode version, which this
 * library's results must not.
 */

import { caseFolding } from '../../vendor/unicode-15.1.0/generated/case-folding.ts';
import { codePoints, fromCodePoints } from './codepoints.ts';
import { nfc } from './nfc.ts';

/** `text` under full case folding (CaseFolding 15.1, `C` and `F`). A code point it does not list is kept. */
export function caseFold(text: string): string {
  const folded: number[] = [];
  for (const point of codePoints(text)) {
    const mapping = caseFolding(point);
    if (mapping === undefined) folded.push(point);
    else folded.push(...mapping);
  }
  return fromCodePoints(folded);
}

/**
 * The form two strings are compared in when a condition is not case-sensitive: NFC, then full case folding, exactly
 * D5's order. Two strings match case-insensitively when this gives the same string for both.
 */
export function foldForComparison(text: string): string {
  return caseFold(nfc(text));
}
