import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Event identity, against core (events phase A plan, decision 23; D3). D3 defines the id over core's canonical JSON
 * and core's SHA-256 (`packages/core/src/digest.ts`), and the library reimplements both without `node:crypto`. So the
 * committed vectors are held to core's own `canonicalJson` and `sha256Hex`, from core's built dist, and the library's
 * built `eventId` to the same values: core is the independent oracle.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const built = (name) => pathToFileURL(join(ROOT, 'packages', name, 'dist', 'index.mjs')).href;

test('CAT-j: every committed preimage and id is core’s canonical JSON and SHA-256, and the library’s', async () => {
  const core = await import(built('core'));
  const events = await import(built('events'));
  const file = JSON.parse(await readFile(join(ROOT, 'packages', 'events', 'test', 'vectors', 'event-id.json'), 'utf8'));
  assert.equal(file.family, 'event-id');
  const ids = file.vectors.filter((vector) => vector.kind === 'id');
  assert.ok(ids.length >= 10);
  for (const { name, input, preimage, sha256, eventId } of ids) {
    const tuple = [
      'agentcomms-event-v1',
      input.installationId,
      input.accountId,
      input.eventType,
      input.typeVersion,
      input.dedupeKey,
    ];
    assert.equal(core.canonicalJson(tuple), preimage, `core's canonical JSON: ${name}`);
    assert.equal(core.sha256Hex(preimage), sha256, `core's SHA-256: ${name}`);
    assert.equal(eventId, sha256.slice(0, 32), `the first 32 characters: ${name}`);
    assert.equal(events.eventIdPreimage(input), preimage, `the library's preimage: ${name}`);
    assert.equal(await events.eventId(input), eventId, `the library's id: ${name}`);
  }
});
