/**
 * UTS #46's CheckJoiners: the ContextJ rules of RFC 5892, Appendix A.1 (ZERO WIDTH NON-JOINER, reported `C1`) and A.2
 * (ZERO WIDTH JOINER, reported `C2`), from the pinned Virama and Joining_Type tables.
 */

import { joiningType } from '../../vendor/unicode-15.1.0/generated/joining-type.ts';
import { isVirama } from '../../vendor/unicode-15.1.0/generated/marks.ts';

const ZWNJ = 0x200c;
const ZWJ = 0x200d;

/** Whether a ZWNJ at `at` stands between (L|D) T* and T* (R|D), A.1's second context. */
function joinsAround(label: readonly number[], at: number): boolean {
  let before = at - 1;
  while (before >= 0 && joiningType(label[before] as number) === 'T') before -= 1;
  if (before < 0) return false;
  const left = joiningType(label[before] as number);
  if (left !== 'L' && left !== 'D') return false;
  let after = at + 1;
  while (after < label.length && joiningType(label[after] as number) === 'T') after += 1;
  if (after >= label.length) return false;
  const right = joiningType(label[after] as number);
  return right === 'R' || right === 'D';
}

/** The ContextJ rules a label breaks: `C1` for a ZWNJ out of context, `C2` for a ZWJ, each at most once. */
export function joinerErrors(label: readonly number[]): string[] {
  const errors: string[] = [];
  for (let at = 0; at < label.length; at += 1) {
    const point = label[at];
    if (point !== ZWNJ && point !== ZWJ) continue;
    const afterVirama = at > 0 && isVirama(label[at - 1] as number);
    if (point === ZWNJ && !afterVirama && !joinsAround(label, at) && !errors.includes('C1')) errors.push('C1');
    if (point === ZWJ && !afterVirama && !errors.includes('C2')) errors.push('C2');
  }
  return errors;
}
