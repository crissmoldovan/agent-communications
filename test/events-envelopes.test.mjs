import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canonicalJson as coreCanonicalJson } from '../packages/core/dist/index.mjs';
import * as events from '../packages/events/dist/index.mjs';

const vectors = JSON.parse(
  readFileSync(new URL('../packages/events/test/vectors/envelopes.json', import.meta.url), 'utf8'),
);

test('MAP-h: every hand-written envelope vector agrees with core canonical JSON and the packed events build', () => {
  for (const vector of vectors.vectors) {
    assert.equal(coreCanonicalJson(vector.expected), vector.bytes, `${vector.name}: independent core oracle`);
    const definition = events.CATALOGUE.find((candidate) => candidate.type === vector.type);
    assert.ok(definition, `${vector.name}: definition`);
    const event = definition.examples[vector.example];
    assert.ok(event, `${vector.name}: example`);
    const compiled = events.compileMapping(definition, vector.template);
    assert.equal(compiled.ok, true, `${vector.name}: mapping compiles`);
    if (!compiled.ok) continue;
    const mapped = events.evaluateMapping(compiled.value, event);
    const classified = events.classifyMapped(definition, event, mapped);
    const data = events.applyRepresentation(mapped.data, classified, { kind: 'plain' });
    const cloudEvent = events.buildCloudEvent(definition, event, {
      deliveryId: vector.deliveryId,
      installationId: 'installation-1',
      ruleId: 'rule-1',
      ruleVersion: 1,
      targetId: 'target-1',
      targetVersion: 1,
      data,
      untrusted: classified.untrusted.map((entry) => entry.pointer),
    });
    assert.deepEqual(cloudEvent, vector.expected, `${vector.name}: structured object`);
    assert.equal(events.cloudEventBytes(cloudEvent), vector.bytes, `${vector.name}: built bytes`);
    assert.equal(Buffer.from(vector.bytes, 'utf8').toString('hex'), vector.hex, `${vector.name}: static UTF-8 hex`);
  }
});
