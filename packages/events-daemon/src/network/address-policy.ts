import { IANA_SPECIAL_PURPOSE, type IanaSpecialPurposeSnapshot } from './iana-special-purpose.ts';

export const ACTIVE_NAT64_PREFIX: null = null;

export class AddressPolicyError extends Error {
  readonly code = 'NETWORK_ADDRESS_REFUSED';

  constructor(message: string) {
    super(message);
    this.name = 'AddressPolicyError';
  }
}

export interface ParsedIpAddress {
  readonly address: string;
  readonly family: 4 | 6;
  readonly value: bigint;
}

export interface ValidatedAddress {
  readonly address: string;
  readonly family: 4 | 6;
  readonly embedded: readonly ParsedIpAddress[];
}

export interface AddressPolicyOptions {
  readonly approvedAddressSet: readonly string[];
  /** A test-only provisioned prefix. Production passes no value and therefore never guesses. */
  readonly activeNat64Prefix?: string | readonly string[] | null;
}

interface Cidr {
  readonly source: string;
  readonly family: 4 | 6;
  readonly prefixLength: number;
  readonly value: bigint;
}

interface RegistryPrefix extends Cidr {
  readonly globallyReachable: boolean;
}

const IPV4_BITS = 32;
const IPV6_BITS = 128;
const IPV4_MAX = (1n << 32n) - 1n;
const IPV6_MAX = (1n << 128n) - 1n;
const WELL_KNOWN_NAT64 = parseCidr('64:ff9b::/96');
const LOCALLY_ASSIGNED_NAT64 = parseCidr('64:ff9b:1::/48');
const LINK_LOCAL_V4 = parseCidr('169.254.0.0/16');
const LINK_LOCAL_V6 = parseCidr('fe80::/10');
// Multicast is not in IANA's special-purpose registries (it has its own), and a delivery endpoint is never a group
// address: both multicast blocks are denied outright, approved address set or not.
const MULTICAST_V4 = parseCidr('224.0.0.0/4');
const MULTICAST_V6 = parseCidr('ff00::/8');
const METADATA_V4 = parseIpLiteral('169.254.169.254');
const METADATA_V6 = parseIpLiteral('fd00:ec2::254');

export const SPECIAL_PURPOSE_SNAPSHOT: IanaSpecialPurposeSnapshot = IANA_SPECIAL_PURPOSE;

const registryPrefixes: readonly RegistryPrefix[] = [
  ...IANA_SPECIAL_PURPOSE.ipv4.prefixes.map((entry) => ({
    ...parseCidr(entry.prefix),
    globallyReachable: entry.globallyReachable,
  })),
  ...IANA_SPECIAL_PURPOSE.ipv6.prefixes.map((entry) => ({
    ...parseCidr(entry.prefix),
    globallyReachable: entry.globallyReachable,
  })),
];

function bitsFor(family: 4 | 6): number {
  return family === 4 ? IPV4_BITS : IPV6_BITS;
}

function maxFor(family: 4 | 6): bigint {
  return family === 4 ? IPV4_MAX : IPV6_MAX;
}

function mask(family: 4 | 6, prefixLength: number): bigint {
  const bits = bitsFor(family);
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > bits)
    throw new AddressPolicyError(`invalid CIDR prefix length ${prefixLength}`);
  if (prefixLength === 0) return 0n;
  return ((1n << BigInt(prefixLength)) - 1n) << BigInt(bits - prefixLength);
}

function stripBrackets(value: string): string {
  if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1);
  return value;
}

function parseIpv4(value: string): bigint | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let result = 0n;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = (result << 8n) | BigInt(octet);
  }
  return result;
}

function ipv4Text(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join('.');
}

function parseIpv6(value: string): bigint | null {
  if (value.includes('%')) return null;
  const doubleColon = value.indexOf('::');
  if (doubleColon !== -1 && value.indexOf('::', doubleColon + 1) !== -1) return null;
  const left = doubleColon === -1 ? value : value.slice(0, doubleColon);
  const right = doubleColon === -1 ? '' : value.slice(doubleColon + 2);
  const leftParts = left === '' ? [] : left.split(':');
  const rightParts = right === '' ? [] : right.split(':');
  const rawParts = [...leftParts, ...rightParts];
  if (rawParts.some((part) => part === '')) return null;

  const groups: number[] = [];
  for (let index = 0; index < rawParts.length; index += 1) {
    const part = rawParts[index];
    if (part === undefined) return null;
    if (part.includes('.')) {
      if (index !== rawParts.length - 1) return null;
      const embedded = parseIpv4(part);
      if (embedded === null) return null;
      groups.push(Number((embedded >> 16n) & 65535n), Number(embedded & 65535n));
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  if (doubleColon === -1) {
    if (groups.length !== 8) return null;
  } else {
    if (groups.length >= 8) return null;
    const omitted = 8 - groups.length;
    groups.splice(
      leftParts.reduce((count, part) => count + (part.includes('.') ? 2 : 1), 0),
      0,
      ...Array<number>(omitted).fill(0),
    );
  }
  let result = 0n;
  for (const group of groups) result = (result << 16n) | BigInt(group);
  return result;
}

function ipv6Text(value: bigint): string {
  const groups = Array.from({ length: 8 }, (_, index) => Number((value >> BigInt((7 - index) * 16)) & 65535n));
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length; ) {
    const group = groups[index];
    if (group === undefined) break;
    if (group !== 0) {
      index += 1;
      continue;
    }
    const start = index;
    while (groups[index] === 0) index += 1;
    const length = index - start;
    if (length > bestLength && length > 1) {
      bestStart = start;
      bestLength = length;
    }
  }
  if (bestStart === 0 && bestLength === 8) return '::';
  const pieces: string[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    if (index === bestStart) {
      pieces.push('');
      index += bestLength - 1;
      if (index === groups.length - 1) pieces.push('');
      continue;
    }
    const group = groups[index];
    if (group === undefined) throw new Error('IPv6 formatter lost a parsed group');
    pieces.push(group.toString(16));
  }
  return pieces.join(':').replace(/^:/, '::').replace(/:$/, '::');
}

/** Parses only a canonical-literal-shaped IP address, never a hostname or a DNS spelling. */
export function parseIpLiteral(input: string): ParsedIpAddress {
  const value = stripBrackets(input.trim());
  const ipv4 = parseIpv4(value);
  if (ipv4 !== null) return { address: ipv4Text(ipv4), family: 4, value: ipv4 };
  const ipv6 = parseIpv6(value);
  if (ipv6 !== null) return { address: ipv6Text(ipv6), family: 6, value: ipv6 };
  throw new AddressPolicyError(`a literal IP address was required, received ${input}`);
}

function parseCidr(input: string): Cidr {
  const slash = input.lastIndexOf('/');
  if (slash <= 0 || slash === input.length - 1) throw new AddressPolicyError(`invalid CIDR ${input}`);
  const address = parseIpLiteral(input.slice(0, slash));
  const prefixLength = Number(input.slice(slash + 1));
  const prefixMask = mask(address.family, prefixLength);
  if ((address.value & prefixMask) !== address.value) throw new AddressPolicyError(`CIDR ${input} has host bits set`);
  return { source: `${address.address}/${prefixLength}`, family: address.family, prefixLength, value: address.value };
}

function inCidr(address: ParsedIpAddress, cidr: Cidr): boolean {
  return address.family === cidr.family && (address.value & mask(cidr.family, cidr.prefixLength)) === cidr.value;
}

function parseApprovedAddressSet(entries: readonly string[]): readonly Cidr[] {
  if (entries.length === 0) throw new AddressPolicyError('approvedAddressSet must be non-empty');
  const parsed = entries.map((entry) =>
    entry.includes('/')
      ? parseCidr(entry)
      : parseCidr(`${parseIpLiteral(entry).address}/${bitsFor(parseIpLiteral(entry).family)}`),
  );
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (previous === undefined || current === undefined)
      throw new AddressPolicyError('approvedAddressSet could not be read');
    if (previous.localeCompare(current) >= 0)
      throw new AddressPolicyError('approvedAddressSet must contain sorted, duplicate-free literals or CIDRs');
  }
  return parsed;
}

/** Checks the persisted rule input before a connector can use it to resolve a host. */
export function assertApprovedAddressSet(entries: readonly string[]): void {
  parseApprovedAddressSet(entries);
}

function isUnconditionallyDenied(address: ParsedIpAddress): boolean {
  return (
    inCidr(address, LINK_LOCAL_V4) ||
    inCidr(address, LINK_LOCAL_V6) ||
    inCidr(address, MULTICAST_V4) ||
    inCidr(address, MULTICAST_V6) ||
    (address.family === METADATA_V4.family && address.value === METADATA_V4.value) ||
    (address.family === METADATA_V6.family && address.value === METADATA_V6.value)
  );
}

function globallyReachable(address: ParsedIpAddress): boolean {
  const match = registryPrefixes
    .filter((entry) => inCidr(address, entry))
    .sort((left, right) => right.prefixLength - left.prefixLength)[0];
  return match?.globallyReachable ?? true;
}

function ipv4From(value: bigint): ParsedIpAddress {
  const ipv4 = value & IPV4_MAX;
  return { address: ipv4Text(ipv4), family: 4, value: ipv4 };
}

function configuredNat64(options: AddressPolicyOptions): Cidr | null {
  const raw = options.activeNat64Prefix ?? ACTIVE_NAT64_PREFIX;
  if (raw === null) return null;
  const entries = typeof raw === 'string' ? [raw] : raw;
  if (entries.length !== 1) throw new AddressPolicyError('NAT64 needs exactly one trusted /96 prefix');
  const prefixText = entries[0];
  if (prefixText === undefined) throw new AddressPolicyError('NAT64 prefix could not be read');
  const prefix = parseCidr(prefixText);
  if (prefix.family !== 6 || prefix.prefixLength !== 96)
    throw new AddressPolicyError('NAT64 needs one trusted IPv6 /96 prefix');
  return prefix;
}

function embeddedAddresses(address: ParsedIpAddress, options: AddressPolicyOptions): readonly ParsedIpAddress[] {
  if (address.family !== 6) return [];
  const embedded: ParsedIpAddress[] = [];
  const upper96 = address.value >> 32n;
  const mapped = upper96 === 0xffffn;
  const compatible = upper96 === 0n && address.value > 1n;
  if (mapped || compatible) embedded.push(ipv4From(address.value));

  const configured = configuredNat64(options);
  const looksNat64 =
    inCidr(address, WELL_KNOWN_NAT64) ||
    inCidr(address, LOCALLY_ASSIGNED_NAT64) ||
    (configured !== null && inCidr(address, configured));
  if (looksNat64) {
    if (configured === null || !inCidr(address, configured))
      throw new AddressPolicyError('NAT64 address has no single trusted active /96 prefix');
    embedded.push(ipv4From(address.value));
  }

  const sixToFour = parseCidr('2002::/16');
  if (inCidr(address, sixToFour)) embedded.push(ipv4From(address.value >> 80n));

  const teredo = parseCidr('2001:0::/32');
  if (inCidr(address, teredo)) {
    embedded.push(ipv4From(address.value >> 64n));
    embedded.push(ipv4From((address.value ^ IPV4_MAX) & IPV4_MAX));
  }
  return embedded;
}

function assertOne(
  address: ParsedIpAddress,
  approved: readonly Cidr[],
  options: AddressPolicyOptions,
  seen: Set<string>,
): readonly ParsedIpAddress[] {
  if (seen.has(`${address.family}:${address.value}`)) return [];
  seen.add(`${address.family}:${address.value}`);
  if (isUnconditionallyDenied(address))
    throw new AddressPolicyError(`address ${address.address} is metadata or link-local and is always refused`);
  const explicitlyApproved = approved.some((entry) => inCidr(address, entry));
  if (!globallyReachable(address) && !explicitlyApproved)
    throw new AddressPolicyError(`non-global address ${address.address} needs an exact approvedAddressSet entry`);
  if (!explicitlyApproved) throw new AddressPolicyError(`address ${address.address} is not in the approvedAddressSet`);
  const nested = embeddedAddresses(address, options);
  for (const child of nested) assertOne(child, approved, options, seen);
  return nested;
}

/** Validates the literal itself and every embedded transition address against the exact approved set. */
export function assertAddressAllowed(input: string, options: AddressPolicyOptions): ValidatedAddress {
  const address = parseIpLiteral(input);
  const approved = parseApprovedAddressSet(options.approvedAddressSet);
  const embedded = assertOne(address, approved, options, new Set());
  return { address: address.address, family: address.family, embedded };
}

/** Alias kept for callers that phrase their boundary as validation rather than an assertion. */
export function validateAddress(input: string, options: AddressPolicyOptions): ValidatedAddress {
  return assertAddressAllowed(input, options);
}

/** Produces deterministic inside and final-boundary literals for a checked-in CIDR test vector. */
export function cidrBoundaryLiterals(input: string): readonly string[] {
  const cidr = parseCidr(input);
  const end = cidr.value | (maxFor(cidr.family) ^ mask(cidr.family, cidr.prefixLength));
  const first = cidr.family === 4 ? ipv4Text(cidr.value) : ipv6Text(cidr.value);
  const insideValue = end - cidr.value >= 2n ? cidr.value + 1n : cidr.value;
  const inside = cidr.family === 4 ? ipv4Text(insideValue) : ipv6Text(insideValue);
  const last = cidr.family === 4 ? ipv4Text(end) : ipv6Text(end);
  return [...new Set([first, inside, last])];
}
