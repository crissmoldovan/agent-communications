import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PART_FACTS, SERVERS, toolPrefix } from '../packages/core/dist/index.mjs';
import { REGISTRY } from '../scripts/channels.mjs';

/*
 * Each part owns its tool prefix (single-server design D5): the gateway routes a call by it and drops a tool a part
 * lists outside it. Core's `toolPrefix` is held to the registry's own view of each channel's tools, so the two cannot
 * drift, and every declared server — the services too — has one, unique.
 */

test('D5: the gateway’s tool prefix of each channel is the registry’s', () => {
  for (const product of REGISTRY.products) {
    assert.equal(toolPrefix(product.channel), product.tool, product.channel);
  }
});

test('D5: every declared server is a part with a prefix of its own, and no word that is not one has a prefix', () => {
  assert.deepEqual(
    PART_FACTS.map((facts) => facts.server),
    [...SERVERS],
  );
  const prefixes = SERVERS.map((server) => toolPrefix(server));
  assert.ok(prefixes.every((prefix) => typeof prefix === 'string' && /^[a-z]+$/.test(prefix)));
  assert.equal(new Set(prefixes).size, prefixes.length, 'no two parts share a prefix');
  assert.equal(toolPrefix('events'), 'events');
  assert.equal(toolPrefix('telegram'), undefined);
});
