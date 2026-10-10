import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACTIVE_NAT64_PREFIX,
  AddressPolicyError,
  assertAddressAllowed,
  validateAddress,
} from '../../src/network/address-policy.ts';

const globalOnly = { addressMode: 'global-only' } as const;

test('E6-A: global-only policy accepts only globally reachable literals and every embedded transition address', () => {
  assert.doesNotThrow(() => assertAddressAllowed('8.8.8.8', globalOnly));
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    'fc00::1',
    '192.0.2.1',
    '2002:a00:1::',
    '2001:0:a00:1::f7ff:fffe',
  ]) {
    assert.throws(
      () => assertAddressAllowed(address, globalOnly),
      (error: unknown) => error instanceof AddressPolicyError && error.code === 'NETWORK_ADDRESS_REFUSED',
      address,
    );
  }
  assert.throws(
    () =>
      assertAddressAllowed('64:ff9b::a00:1', {
        addressMode: 'global-only',
        activeNat64Prefix: '64:ff9b::/96',
      }),
    (error: unknown) => error instanceof AddressPolicyError && /global/i.test(error.message),
    'a global NAT64 outer address cannot hide an RFC 1918 embedded address',
  );
});

test('NET-B2: validates the outer and every embedded transition address', () => {
  assert.throws(
    () => assertAddressAllowed('::ffff:169.254.169.254', { approvedAddressSet: ['::ffff:0:0/96'] }),
    (error: unknown) => error instanceof AddressPolicyError && error.code === 'NETWORK_ADDRESS_REFUSED',
  );
  assert.throws(
    () => assertAddressAllowed('2002:a9fe:a9fe::', { approvedAddressSet: ['2002::/16', '169.254.0.0/16'] }),
    (error: unknown) => error instanceof AddressPolicyError && error.code === 'NETWORK_ADDRESS_REFUSED',
  );
  assert.throws(
    () => assertAddressAllowed('2002:808:808::', { approvedAddressSet: ['8.8.8.8'] }),
    (error: unknown) => error instanceof AddressPolicyError && error.code === 'NETWORK_ADDRESS_REFUSED',
    'a safe embedded address cannot compensate for an unapproved outer transition address',
  );
  assert.throws(
    () => assertAddressAllowed('2002:808:808::', { approvedAddressSet: ['2002::/16'] }),
    (error: unknown) => error instanceof AddressPolicyError && error.code === 'NETWORK_ADDRESS_REFUSED',
    'an approved outer transition address cannot compensate for an unapproved embedded address',
  );
  assert.throws(
    () => assertAddressAllowed('2001:0:a00:1::f7f7:f7f7', { approvedAddressSet: ['2001::/32', '10.0.0.0/8'] }),
    (error: unknown) => error instanceof AddressPolicyError && error.code === 'NETWORK_ADDRESS_REFUSED',
  );
  assert.throws(
    () => assertAddressAllowed('64:ff9b::808:808', { approvedAddressSet: ['64:ff9b::/96', '8.8.8.8'] }),
    /NAT64/i,
  );
  assert.throws(
    () => assertAddressAllowed('64:ff9b:1::808:808', { approvedAddressSet: ['64:ff9b:1::/48', '8.8.8.8'] }),
    /NAT64/i,
  );

  const accepted = assertAddressAllowed('64:ff9b::808:808', {
    approvedAddressSet: ['64:ff9b::/96', '8.8.8.8'],
    activeNat64Prefix: '64:ff9b::/96',
  });
  assert.deepEqual(
    accepted.embedded.map((entry) => entry.address),
    ['8.8.8.8'],
  );
  assert.equal(ACTIVE_NAT64_PREFIX, null, 'production never guesses an active NAT64 prefix');
});

test('NET-B2: accepts transition addresses only when their outer and embedded literals are all pinned', () => {
  assert.doesNotThrow(() =>
    assertAddressAllowed('::ffff:8.8.8.8', {
      approvedAddressSet: ['::ffff:0:0/96', '8.8.8.8'],
    }),
  );
  assert.doesNotThrow(() =>
    assertAddressAllowed('::8.8.8.8', {
      approvedAddressSet: ['::/96', '8.8.8.8'],
    }),
  );
  assert.doesNotThrow(() =>
    assertAddressAllowed('2002:808:808::', {
      approvedAddressSet: ['2002::/16', '8.8.8.8'],
    }),
  );
  assert.doesNotThrow(() =>
    assertAddressAllowed('2001:0:a00:1::f7f7:f7f7', {
      approvedAddressSet: ['10.0.0.0/8', '2001::/32', '8.8.8.8'],
    }),
  );
});

test('NET-B2: refuses malformed, multiple, or ambiguous active NAT64 configuration', () => {
  for (const activeNat64Prefix of [[], ['64:ff9b::/96', '64:ff9b:1::/96'], ['2001:db8::/64']]) {
    assert.throws(
      () =>
        validateAddress('64:ff9b::808:808', {
          approvedAddressSet: ['64:ff9b::/96', '8.8.8.8'],
          activeNat64Prefix,
        }),
      /NAT64/i,
    );
  }
});
