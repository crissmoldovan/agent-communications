/**
 * The Bidi rule of RFC 5893, §2, as UTS #46's CheckBidi applies it: only in a Bidi domain name, and then to every
 * label. Each of the six conditions that fails is reported by its number, `B1`–`B6`, as IdnaTestV2 reports them.
 */

import { type BidiClass, bidiClass } from '../../vendor/unicode-15.1.0/generated/bidi-class.ts';

const RTL_ALLOWED: ReadonlySet<BidiClass | undefined> = new Set([
  'R',
  'AL',
  'AN',
  'EN',
  'ES',
  'CS',
  'ET',
  'ON',
  'BN',
  'NSM',
]);
const LTR_ALLOWED: ReadonlySet<BidiClass | undefined> = new Set(['L', 'EN', 'ES', 'CS', 'ET', 'ON', 'BN', 'NSM']);
const RTL_END: ReadonlySet<BidiClass | undefined> = new Set(['R', 'AL', 'EN', 'AN']);
const LTR_END: ReadonlySet<BidiClass | undefined> = new Set(['L', 'EN']);

/** Whether a label has a right-to-left character: Bidi_Class R, AL or AN (RFC 5893, §1.4). */
export function isRtlLabel(label: readonly number[]): boolean {
  return label.some((point) => {
    const value = bidiClass(point);
    return value === 'R' || value === 'AL' || value === 'AN';
  });
}

/**
 * The RFC 5893 conditions a non-empty label of a Bidi domain name breaks. The first character decides the direction:
 * R or AL make a right-to-left label, held to conditions 2–4, and L a left-to-right one, held to 5 and 6. A first
 * character of any other class breaks condition 1, `B1`, and the label is judged no further — as IdnaTestV2.txt
 * reports it, and the label is refused either way.
 *
 * A code point UnicodeData.txt 15.1 does not assign has no class here (`undefined`), which no condition allows. Such a
 * code point is always disallowed by UTS #46 (`V6`), so this never decides whether a domain is accepted; it can only
 * change which `B` codes accompany that refusal.
 */
export function bidiErrors(label: readonly number[]): string[] {
  const errors: string[] = [];
  const classes = label.map(bidiClass);
  const first = classes[0];
  const rtl = first === 'R' || first === 'AL';
  if (!rtl && first !== 'L') {
    errors.push('B1');
    return errors;
  }
  // The last character that is not NSM: conditions 3 and 6 allow any number of NSM after it.
  let end = classes.length - 1;
  while (end >= 0 && classes[end] === 'NSM') end -= 1;
  if (rtl) {
    if (classes.some((value) => !RTL_ALLOWED.has(value))) errors.push('B2');
    if (end >= 0 && !RTL_END.has(classes[end])) errors.push('B3');
    if (classes.includes('EN') && classes.includes('AN')) errors.push('B4');
  } else {
    if (classes.some((value) => !LTR_ALLOWED.has(value))) errors.push('B5');
    if (end >= 0 && !LTR_END.has(classes[end])) errors.push('B6');
  }
  return errors;
}
