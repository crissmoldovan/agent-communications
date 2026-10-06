/**
 * UTS #46 revision 31 (Unicode 15.1) ToASCII, with exactly the flags design D5 names: nontransitional processing,
 * UseSTD3ASCIIRules, CheckHyphens, CheckBidi, CheckJoiners and VerifyDnsLength all true, and IgnoreInvalidPunycode
 * false. The mapping table, NFC and every property it reads are the bundled 15.1 tables, so Node and a webview can
 * never fall through to different platform IDNA libraries. It is held to every line of Unicode's IdnaTestV2.txt 15.1:
 * the `toAsciiN` value and the exact set of status codes that file reports.
 */

import { idnaMapping, idnaStatus } from '../../vendor/unicode-15.1.0/generated/idna-mapping.ts';
import { isMark } from '../../vendor/unicode-15.1.0/generated/marks.ts';
import { codePoints, fromCodePoints } from '../unicode/codepoints.ts';
import { nfc } from '../unicode/nfc.ts';
import { bidiErrors, isRtlLabel } from './bidi.ts';
import { joinerErrors } from './joiners.ts';
import { decodePunycode, encodePunycode } from './punycode.ts';

const FULL_STOP = 0x2e;
const HYPHEN = 0x2d;
const ACE_PREFIX = [0x78, 0x6e, 0x2d, 0x2d]; // xn--

/** What ToASCII made of a domain: its result as far as it could go, and every error it recorded, as status codes. */
export interface Uts46Outcome {
  /** The ASCII form, converted as far as was possible even where an error was recorded (UTS #46, §4). */
  readonly ascii: string;
  /**
   * The status codes IdnaTestV2.txt uses for each failed step, sorted and each once: `P4` (Punycode), `V1`–`V6`
   * (validity criteria), `C1`–`C2` (ContextJ), `B1`–`B6` (Bidi), `A3` (Punycode encoding) and `A4_1`–`A4_2` (DNS
   * lengths). Empty exactly when ToASCII succeeded.
   */
  readonly errors: readonly string[];
  /** Whether the domain ends in the empty root label, a trailing `.` after mapping. UTS #46 lets it through. */
  readonly rootLabel: boolean;
}

const startsWithAce = (label: readonly number[]): boolean =>
  label.length >= 4 && ACE_PREFIX.every((point, at) => label[at] === point);

/** Step 1, Map, with UseSTD3ASCIIRules: a `disallowed_STD3_*` code point is disallowed, and left as it is. */
function map(domain: string): number[] {
  const mapped: number[] = [];
  for (const point of codePoints(domain)) {
    const status = idnaStatus(point);
    if (status === 'ignored') continue;
    if (status === 'mapped') mapped.push(...(idnaMapping(point) as readonly number[]));
    else mapped.push(point);
  }
  return mapped;
}

/** §4.1, the validity criteria for a non-empty label under nontransitional processing, with every flag on. */
function validate(label: readonly number[], errors: Set<string>): void {
  if (label.length === 0) return;
  const text = fromCodePoints(label);
  if (nfc(text) !== text) errors.add('V1');
  if (label[2] === HYPHEN && label[3] === HYPHEN) errors.add('V2');
  if (label[0] === HYPHEN || label[label.length - 1] === HYPHEN) errors.add('V3');
  if (label.includes(FULL_STOP)) errors.add('V4');
  if (isMark(label[0] as number)) errors.add('V5');
  for (const point of label) {
    const status = idnaStatus(point);
    if (status !== 'valid' && status !== 'deviation') {
      errors.add('V6');
      break;
    }
  }
  for (const error of joinerErrors(label)) errors.add(error);
}

/** UTS #46 §4.2 ToASCII of `domain`, every flag as D5 sets it. */
export function uts46ToAscii(domain: string): Uts46Outcome {
  const errors = new Set<string>();
  // Steps 1–3: map, normalise, break into labels at U+002E.
  const normalized = codePoints(nfc(fromCodePoints(map(domain))));
  const labels: number[][] = [[]];
  for (const point of normalized) {
    if (point === FULL_STOP) labels.push([]);
    else (labels[labels.length - 1] as number[]).push(point);
  }
  // Step 4: convert each `xn--` label from Punycode, and validate.
  const converted = labels.map((label) => {
    if (!startsWithAce(label)) {
      validate(label, errors);
      return label;
    }
    if (label.some((point) => point >= 0x80)) {
      errors.add('P4');
      return label;
    }
    const decoded = decodePunycode(label.slice(4));
    if (decoded === undefined) {
      errors.add('P4');
      return label;
    }
    validate(decoded, errors);
    return decoded;
  });
  // CheckBidi, over the whole domain: when any label is right-to-left, every label is held to RFC 5893.
  if (converted.some(isRtlLabel)) {
    for (const label of converted) if (label.length > 0) for (const error of bidiErrors(label)) errors.add(error);
  }
  // ToASCII: Punycode for each label with a non-ASCII code point, then the DNS lengths.
  const ascii = converted.map((label) => {
    if (!label.some((point) => point >= 0x80)) return label;
    const encoded = encodePunycode(label);
    if (encoded === undefined) {
      errors.add('A3');
      return label;
    }
    return [...ACE_PREFIX, ...encoded];
  });
  const rootLabel = ascii.length > 1 && (ascii[ascii.length - 1] as number[]).length === 0;
  const counted = rootLabel ? ascii.slice(0, -1) : ascii;
  if (counted.some((label) => label.length === 0 || label.length > 63)) errors.add('A4_2');
  if (counted.reduce((total, label) => total + label.length, counted.length - 1) > 253) errors.add('A4_1');
  return {
    ascii: ascii.map((label) => fromCodePoints(label)).join('.'),
    errors: [...errors].sort(),
    rootLabel,
  };
}
