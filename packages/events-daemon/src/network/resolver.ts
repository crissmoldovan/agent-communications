import dns from 'node:dns';
import { AddressPolicyError, parseIpLiteral } from './address-policy.ts';

export interface AddressResolver {
  lookup(hostname: string): Promise<readonly string[]>;
}

/** The production resolver deliberately has no cache and asks Node for every address on every call. */
export const systemAddressResolver: AddressResolver = {
  async lookup(hostname: string): Promise<readonly string[]> {
    const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    return answers.map((answer) => answer.address);
  },
};

/** A literal host is its singleton answer; a hostname is resolved afresh by the injected resolver. */
export async function resolveHost(
  hostname: string,
  resolver: AddressResolver = systemAddressResolver,
): Promise<readonly string[]> {
  try {
    return [parseIpLiteral(hostname).address];
  } catch (error) {
    if (!(error instanceof AddressPolicyError)) throw error;
  }
  const answers = await resolver.lookup(hostname);
  if (answers.length === 0) throw new AddressPolicyError(`resolver returned no addresses for ${hostname}`);
  return answers;
}
