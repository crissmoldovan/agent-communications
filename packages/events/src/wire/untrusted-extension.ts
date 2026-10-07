import type { JsonValue } from '../json.ts';
import { getPointer, parsePointer } from '../pointer.ts';
import { EventsError } from '../result.ts';
import { compareUtf8 } from '../text.ts';
import { percentEncodeComponent } from './percent.ts';

/** D6's canonical scalar encoding for concrete untrusted pointers, or undefined when it has none. */
export function encodeUntrustedExtension(data: JsonValue, pointers: readonly string[]): string | undefined {
  const unique = [...new Set(pointers)];
  for (const pointer of unique) {
    const parsed = parsePointer(pointer);
    if (!parsed.ok) {
      throw new EventsError(
        'UNTRUSTED_POINTER_INVALID',
        `the untrusted pointer ${JSON.stringify(pointer)} is not an RFC 6901 pointer`,
        pointer,
      );
    }
    const value = getPointer(data, pointer);
    if (!value.found || typeof value.value !== 'string') {
      throw new EventsError(
        'UNTRUSTED_POINTER_INVALID',
        `the untrusted pointer ${JSON.stringify(pointer)} is not present in data as a string`,
        pointer,
      );
    }
  }
  if (unique.length === 0) return undefined;
  if (unique.includes('')) return '';
  return unique.sort(compareUtf8).map(percentEncodeComponent).join(',');
}
