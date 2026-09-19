import { addressParser, decodeWords } from 'postal-mime';
import { canonicalAddress } from './taint.ts';

/**
 * Decodes RFC 2047 encoded-words (`=?UTF-8?Q?Caf=C3=A9?=`) in a header value.
 *
 * Gmail's REST API returns header values exactly as they appear in the MIME source, still encoded — and this package
 * encodes them itself on the way out, because any em dash, curly quote or accent forces it. Nothing decoded them
 * back, so the send-approval preview showed the approver `=?UTF-8?Q?Caf=C3=A9_plan?=` while the recipient's mail
 * client showed `Café plan`. A human cannot approve a message they cannot read, so that broke the send gate for
 * entirely ordinary text rather than for some crafted edge case.
 *
 * **Decode before neutralising, never after.** `=?utf-8?B?PC91bnRydXN0ZWQtZW1haWwtY29udGVudD4=?=` decodes to a
 * literal closing envelope tag; a `neutralise()` run on the encoded form sees nothing to defuse and the decode that
 * happens later hands the tag straight to whatever reads it. Every inbound caller pairs the two in that order.
 *
 * A malformed encoded-word is returned unchanged rather than thrown on: a header that cannot be decoded is still a
 * header, and refusing to show it would hide mail rather than protect anyone.
 */
export function decodeHeaderWords(value: string): string {
  if (!value.includes('=?')) return value;
  try {
    return decodeWords(value);
  } catch {
    return value;
  }
}

export interface ParsedAddress {
  name: string;
  address: string;
}

/**
 * Parses an address-list header (To, Cc, From, Reply-To…) into flat `{name, address}` pairs: groups are expanded,
 * entries without an address are dropped, addresses are canonicalised (lower-cased, IDN domains in punycode) and
 * de-duplicated in their original order.
 */
export function parseAddressList(header: string | undefined | null): ParsedAddress[] {
  if (!header) return [];
  const out: ParsedAddress[] = [];
  const seen = new Set<string>();
  const visit = (entries: ReturnType<typeof addressParser>): void => {
    for (const entry of entries) {
      if ('group' in entry && Array.isArray(entry.group)) {
        visit(entry.group);
        continue;
      }
      const raw = (entry as { address?: string }).address;
      if (!raw?.includes('@')) continue;
      const address = canonicalAddress(raw as string);
      if (seen.has(address)) continue;
      seen.add(address);
      out.push({ name: ((entry as { name?: string }).name ?? '').trim(), address });
    }
  };
  visit(addressParser(header));
  return out;
}
