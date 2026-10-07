import type { Runner } from './types.ts';

interface EnvelopeVector {
  readonly name: string;
  readonly type: string;
  readonly example: number;
  readonly deliveryId: string;
  readonly template: unknown;
  readonly expected: unknown;
  readonly bytes: string;
  readonly hex: string;
}

export const envelopesRunner: Runner = (library, file) => {
  const results: unknown[] = [];
  const failures: string[] = [];
  for (const vector of file.vectors as readonly EnvelopeVector[]) {
    const definition = library.CATALOGUE.find((candidate) => candidate.type === vector.type);
    const event = definition?.examples[vector.example];
    if (definition === undefined || event === undefined) {
      failures.push(`${vector.name}: catalogue example is unavailable`);
      continue;
    }
    const compiled = library.compileMapping(definition as never, vector.template);
    if (!compiled.ok) {
      failures.push(`${vector.name}: mapping did not compile`);
      continue;
    }
    const mapped = library.evaluateMapping(compiled.value, event);
    const classified = library.classifyMapped(definition as never, event, mapped);
    const data = library.applyRepresentation(mapped.data, classified, { kind: 'plain' });
    const cloudEvent = library.buildCloudEvent(definition as never, event, {
      deliveryId: vector.deliveryId,
      installationId: 'installation-1',
      ruleId: 'rule-1',
      ruleVersion: 1,
      targetId: 'target-1',
      targetVersion: 1,
      data,
      untrusted: classified.untrusted.map((entry) => entry.pointer),
    });
    const bytes = library.cloudEventBytes(cloudEvent);
    const hex = Array.from(library.utf8Encode(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
    results.push({ name: vector.name, cloudEvent, bytes, hex });
    if (JSON.stringify(cloudEvent) !== JSON.stringify(vector.expected))
      failures.push(`${vector.name}: envelope differs`);
    if (bytes !== vector.bytes) failures.push(`${vector.name}: canonical bytes differ`);
    if (hex !== vector.hex) failures.push(`${vector.name}: UTF-8 hex differs`);
  }
  return { results, failures };
};
