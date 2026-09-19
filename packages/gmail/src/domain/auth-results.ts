import { parseAddressList } from '@agentcomms/core';
import { headerValues } from './mime.ts';

/**
 * Who Google says the message really came from.
 *
 * `Authentication-Results` is a header **anyone can add**: a sender may include a forged one claiming every check
 * passed, and it will sit in the message beside Google's. RFC 8601 says a reader must trust only the instances added
 * by its own trust boundary, so this reads the topmost header whose authserv-id is `mx.google.com` and ignores every
 * other one — including ones that look more convincing.
 */

export interface AuthResults {
  /** The authserv-id whose verdict this is, or null when no header from Google was present. */
  evaluatedBy: string | null;
  spf: string | null;
  dkim: string | null;
  /** The domain DKIM actually signed for (`header.d`), which is what alignment is judged on. */
  dkimDomain: string | null;
  dmarc: string | null;
  /** True when the DKIM-signed domain matches the From domain. */
  aligned: boolean | null;
  /** Headers that claimed to be authentication results but were not Google's, and were ignored. */
  ignoredHeaders: number;
}

const GOOGLE_AUTHSERV = 'mx.google.com';

function methodResult(header: string, method: string): { result: string | null; properties: Map<string, string> } {
  // `dkim=pass header.i=@example.com header.d=example.com`
  const pattern = new RegExp(`(?:^|;)\\s*${method}\\s*=\\s*([a-z]+)((?:\\s+[\\w.]+=[^;]+)*)`, 'i');
  const match = pattern.exec(header);
  if (!match) return { result: null, properties: new Map() };
  const properties = new Map<string, string>();
  for (const property of (match[2] ?? '').matchAll(/([\w.]+)=("([^"]*)"|[^\s;]+)/g)) {
    properties.set((property[1] ?? '').toLowerCase(), (property[3] ?? property[2] ?? '').trim());
  }
  return { result: (match[1] ?? '').toLowerCase(), properties };
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/** Reads the verdict from Gmail's own header; everything else is counted and discarded. */
export function readAuthResults(
  headers: Parameters<typeof headerValues>[0],
  fromHeader: string | undefined,
): AuthResults {
  const all = headerValues(headers, 'Authentication-Results');
  const mine = all.filter((header) => {
    const authserv = header.trim().split(/[\s;]/)[0]?.toLowerCase() ?? '';
    return authserv === GOOGLE_AUTHSERV;
  });
  const chosen = mine[0];
  if (!chosen) {
    return {
      evaluatedBy: null,
      spf: null,
      dkim: null,
      dkimDomain: null,
      dmarc: null,
      aligned: null,
      ignoredHeaders: all.length,
    };
  }

  const spf = methodResult(chosen, 'spf');
  const dkim = methodResult(chosen, 'dkim');
  const dmarc = methodResult(chosen, 'dmarc');
  const dkimDomain = dkim.properties.get('header.d')?.toLowerCase() ?? null;
  const from = parseAddressList(fromHeader)[0]?.address;
  const fromDomain = from ? domainOf(from) : null;

  return {
    evaluatedBy: GOOGLE_AUTHSERV,
    spf: spf.result,
    dkim: dkim.result,
    dkimDomain,
    dmarc: dmarc.result,
    aligned:
      dkim.result === 'pass' && dkimDomain && fromDomain
        ? dkimDomain === fromDomain || fromDomain.endsWith(`.${dkimDomain}`)
        : dkim.result === 'pass'
          ? false
          : null,
    ignoredHeaders: all.length - mine.length,
  };
}

export interface SenderWarnings {
  /** A Reply-To pointing somewhere other than the sender: normal for lists, and how a reply gets redirected. */
  replyToDiffers: boolean;
  replyToDomains: string[];
  /** A display name that itself contains an address — "billing@bank.test" <attacker@evil.test>. */
  displayNameContainsOtherAddress: boolean;
  /** The sender's domain, for a caller deciding whether it is internal. */
  fromDomain: string | null;
}

/** The two things about a sender that most often mislead a reader, computed rather than judged. */
export function readSenderWarnings(fromHeader: string | undefined, replyToHeader: string | undefined): SenderWarnings {
  const from = parseAddressList(fromHeader);
  const replyTo = parseAddressList(replyToHeader);
  const fromAddress = from[0]?.address ?? null;
  const fromDomain = fromAddress ? domainOf(fromAddress) : null;

  const nameHasOtherAddress = from.some((entry) => {
    const inName = entry.name.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? [];
    return inName.some((address) => address.toLowerCase() !== entry.address);
  });

  const replyToAddresses = replyTo.map((entry) => entry.address);
  return {
    replyToDiffers: replyToAddresses.length > 0 && replyToAddresses.some((address) => address !== fromAddress),
    replyToDomains: [...new Set(replyToAddresses.map(domainOf))],
    displayNameContainsOtherAddress: nameHasOtherAddress,
    fromDomain,
  };
}
