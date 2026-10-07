/**
 * The `uuid` format: RFC 9562's (formerly RFC 4122's) string form, as JSON Schema 2020-12 reads it — five groups of
 * 8, 4, 4, 4 and 12 hexadecimal digits separated by hyphens, in either case, of any version or variant.
 */

const GROUPS = [8, 4, 4, 4, 12];

const isHex = (code: number) =>
  (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);

/** Whether `value` is a UUID string. */
export function isUuid(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 36) return false;
  let at = 0;
  for (const [index, width] of GROUPS.entries()) {
    if (index > 0) {
      if (value[at] !== '-') return false;
      at += 1;
    }
    for (let i = at; i < at + width; i += 1) if (!isHex(value.charCodeAt(i))) return false;
    at += width;
  }
  return at === value.length;
}
