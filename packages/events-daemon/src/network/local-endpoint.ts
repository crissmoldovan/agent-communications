import { AddressPolicyError, assertAddressAllowed, parseIpLiteral } from './address-policy.ts';

export class LocalEndpointError extends Error {
  readonly code = 'LOCAL_ENDPOINT_REFUSED';

  constructor(message: string) {
    super(message);
    this.name = 'LocalEndpointError';
  }
}

export interface LocalEndpoint {
  readonly url: URL;
  readonly address: '127.0.0.1' | '::1';
}

/** Validates the deliberately narrow local-only network descriptor. */
export function validateLocalEndpoint(input: URL | string, approvedAddressSet: readonly string[]): LocalEndpoint {
  const url = typeof input === 'string' ? new URL(input) : new URL(input.href);
  const hostname =
    url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  if (url.protocol !== 'http:') throw new LocalEndpointError('a local endpoint must use HTTP');
  if (url.username !== '' || url.password !== '' || url.hash !== '')
    throw new LocalEndpointError('a local endpoint URL has unsupported authority data');
  let address: string;
  try {
    address = parseIpLiteral(hostname).address;
    assertAddressAllowed(address, { approvedAddressSet });
  } catch (error) {
    if (error instanceof AddressPolicyError) throw new LocalEndpointError(error.message);
    throw error;
  }
  if (address !== '127.0.0.1' && address !== '::1')
    throw new LocalEndpointError('a local endpoint must use literal 127.0.0.1 or ::1');
  if (
    approvedAddressSet.length !== 1 ||
    approvedAddressSet[0] === undefined ||
    approvedAddressSet[0].includes('/') ||
    parseIpLiteral(approvedAddressSet[0]).address !== address
  )
    throw new LocalEndpointError('a local endpoint requires its one exact approved literal loopback address');
  return { url, address };
}
