import { utf8Encode } from '../text.ts';

const HEX = '0123456789ABCDEF';

/** RFC 3986 component encoding over UTF-8 bytes: unreserved characters stay, every other byte is uppercase `%HH`. */
export function percentEncodeComponent(text: string): string {
  let encoded = '';
  for (const byte of utf8Encode(text)) {
    const unreserved =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x7e;
    encoded += unreserved ? String.fromCharCode(byte) : `%${HEX[(byte >> 4) & 15]}${HEX[byte & 15]}`;
  }
  return encoded;
}
