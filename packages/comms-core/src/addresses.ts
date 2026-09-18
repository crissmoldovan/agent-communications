import { addressParser } from 'postal-mime';
import { canonicalAddress } from './taint.ts';

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
      if (!raw || !raw.includes('@')) continue;
      const address = canonicalAddress(raw);
      if (seen.has(address)) continue;
      seen.add(address);
      out.push({ name: ((entry as { name?: string }).name ?? '').trim(), address });
    }
  };
  visit(addressParser(header));
  return out;
}
