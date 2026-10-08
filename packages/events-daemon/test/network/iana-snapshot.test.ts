import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  AddressPolicyError,
  assertAddressAllowed,
  cidrBoundaryLiterals,
  SPECIAL_PURPOSE_SNAPSHOT,
} from '../../src/network/address-policy.ts';
import snapshot from '../fixtures/iana-special-purpose-2025-10-09.json' with { type: 'json' };

// IANA's own CSV exports of the two special-purpose registries (registry last updated 2025-10-09; fetched 2026-10-09
// from the url each registry records). The snapshot is derived from them and nothing else, so it cannot drift from
// its source: an entry with any value but a plain `True` in "Globally Reachable" — False, a footnoted False, a
// deprecated block's empty cell, a transition block's N/A — is treated as not globally reachable.
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field !== '' || row.length > 0) rows.push([...row, field]);
  return rows;
}

function derived(family: 'ipv4' | 'ipv6') {
  const raw = readFileSync(new URL(`../fixtures/iana/iana-${family}-special-registry-1.csv`, import.meta.url));
  const [header, ...rows] = csvRows(raw.toString('utf8'));
  const block = header?.indexOf('Address Block') ?? -1;
  const reachable = header?.indexOf('Globally Reachable') ?? -1;
  assert.ok(block >= 0 && reachable >= 0, `${family}: the registry export keeps its columns`);
  return {
    rawSourceSha256: createHash('sha256').update(raw).digest('hex'),
    prefixes: rows.flatMap((row) =>
      (row[block] as string)
        .split(',')
        .map((prefix) => prefix.replace(/\[\d+\]/g, '').trim())
        .filter((prefix) => prefix !== '')
        .map((prefix) => ({ prefix, globallyReachable: (row[reachable] as string).trim() === 'True' })),
    ),
  };
}

test('NET-B2: the checked-in IANA policy is exactly what its checked-in registry exports say', () => {
  assert.equal(SPECIAL_PURPOSE_SNAPSHOT.snapshotVersion, 'iana-special-purpose-2025-10-09');
  assert.deepEqual(SPECIAL_PURPOSE_SNAPSHOT, snapshot);
  for (const family of ['ipv4', 'ipv6'] as const) {
    const registry = snapshot[family];
    assert.equal(registry.lastUpdated, '2025-10-09');
    assert.match(registry.url, new RegExp(`^https://www\\.iana\\.org/assignments/iana-${family}-special-registry/`));
    const source = derived(family);
    assert.equal(registry.rawSourceSha256, source.rawSourceSha256, `${family}: the hash is of the checked-in export`);
    assert.deepEqual(registry.prefixes, source.prefixes, `${family}: every entry, and only those, is derived`);
  }
});

test('NET-B2: the registry ranges people most often meet are non-global: private, shared, loopback, Teredo, 6to4', () => {
  const nonGlobal = new Set(
    [...snapshot.ipv4.prefixes, ...snapshot.ipv6.prefixes]
      .filter((entry) => !entry.globallyReachable)
      .map((entry) => entry.prefix),
  );
  for (const prefix of [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '0.0.0.0/8',
    '0.0.0.0/32',
    '::1/128',
    'fc00::/7',
    '2001::/32',
    '2002::/16',
  ])
    assert.ok(nonGlobal.has(prefix), `${prefix} is in the registry and not globally reachable`);
});

test('NET-B2: every non-global registry range refuses both an inside and boundary literal without matching approval', () => {
  for (const registry of [snapshot.ipv4, snapshot.ipv6]) {
    for (const entry of registry.prefixes.filter((prefix) => !prefix.globallyReachable)) {
      for (const address of cidrBoundaryLiterals(entry.prefix)) {
        assert.throws(
          () => assertAddressAllowed(address, { approvedAddressSet: ['8.8.8.8'] }),
          (error: unknown) => error instanceof AddressPolicyError && error.code === 'NETWORK_ADDRESS_REFUSED',
          `${entry.prefix} must not become globally reachable by omission`,
        );
      }
    }
  }
});

test('NET-B2: metadata and link-local ranges refuse even through a matching approved CIDR', () => {
  for (const [address, approval] of [
    ['169.254.169.254', '169.254.0.0/16'],
    ['fd00:ec2::254', 'fc00::/7'],
    ['fe80::1', 'fe80::/10'],
  ] as const) {
    assert.throws(
      () => assertAddressAllowed(address, { approvedAddressSet: [approval] }),
      (error: unknown) => error instanceof AddressPolicyError && error.code === 'NETWORK_ADDRESS_REFUSED',
    );
  }
});

test('NET-B2: multicast, which no special-purpose registry lists, is refused outright, even through an approved range', () => {
  for (const [address, approval] of [
    ['224.0.0.1', '224.0.0.0/4'],
    ['239.255.255.250', '224.0.0.0/4'],
    ['ff02::1', 'ff00::/8'],
  ] as const) {
    assert.throws(
      () => assertAddressAllowed(address, { approvedAddressSet: [approval] }),
      (error: unknown) => error instanceof AddressPolicyError && error.code === 'NETWORK_ADDRESS_REFUSED',
      `${address} is a group address, never a delivery endpoint`,
    );
  }
});
