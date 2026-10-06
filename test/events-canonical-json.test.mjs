import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * `@agentcomms/events` cannot import core — core's digest and envelope import `node:crypto` — so it writes canonical
 * JSON itself (events phase A plan, decision 11). The event identity, the rule documents and every wire byte vector
 * hash or compare that text, so it must be core's exactly. This compares the two built packages, through their
 * published entries, over the library's vector file: core is the independent oracle.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const built = (name) => pathToFileURL(join(ROOT, 'packages', name, 'dist', 'index.mjs')).href;

/** The vector's input with its `undefined` members put in, which JSON itself cannot hold. */
function revive(vector) {
  const input = structuredClone(vector.input);
  for (const path of vector.undefinedMembers ?? []) {
    let at = input;
    for (const key of path.slice(0, -1)) at = at[key];
    at[path.at(-1)] = undefined;
  }
  return input;
}

test("CJ-a: canonical JSON is core's, byte for byte", async () => {
  const core = await import(built('core'));
  const events = await import(built('events'));
  const file = JSON.parse(
    await readFile(join(ROOT, 'packages', 'events', 'test', 'vectors', 'canonical-json.json'), 'utf8'),
  );
  assert.equal(file.family, 'canonical-json');
  assert.ok(file.vectors.length >= 10, 'the vector file is too thin to prove anything');
  for (const vector of file.vectors) {
    assert.equal(core.canonicalJson(revive(vector)), vector.canonical, `core: ${vector.name}`);
    assert.equal(events.canonicalJson(revive(vector)), vector.canonical, `events: ${vector.name}`);
  }
  // The case the library's own order would get wrong if it sorted keys as UTF-8: core sorts by UTF-16 code units.
  const order = { '｡': 1, '\u{1F600}': 2 };
  assert.equal(events.canonicalJson(order), core.canonicalJson(order));
  assert.equal(events.canonicalJson(order), '{"\u{1F600}":2,"｡":1}');
});
