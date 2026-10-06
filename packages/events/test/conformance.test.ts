import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import * as library from '../src/index.ts';
import { RUNNERS, type VectorFile } from './realm/runners/index.ts';
import { createRealm, PACKAGE_ROOT, type Realm, realmBundle } from './support/realm.ts';

/**
 * Every vector family, run twice: in Node against `src/`, and in a bare ECMAScript realm against the browser-platform
 * bundle (events phase A plan, decision 3). Both runs must report no failures and return the same JSON, byte for
 * byte. A vector file whose family has no runner fails, so no file is silently skipped.
 */

const VECTORS = join(PACKAGE_ROOT, 'test', 'vectors');

let realm: Realm;
before(async () => {
  realm = createRealm(await realmBundle());
});

test('ISO-b: the bare realm has no host: no Node, no web, and no code generation from strings', () => {
  const names = ['process', 'require', 'Buffer', 'setTimeout', 'fetch', 'URL', 'TextEncoder', 'console'];
  const seen = JSON.parse(
    realm.evaluate(`JSON.stringify({ ${names.map((name) => `${name}: typeof ${name}`).join(', ')} })`) as string,
  );
  assert.deepEqual(seen, Object.fromEntries(names.map((name) => [name, 'undefined'])));
  // The app's CSP has no 'unsafe-eval' (D13); the realm refuses code from strings the same way.
  assert.equal(
    realm.evaluate(`(() => { try { new Function(''); return 'ran'; } catch (error) { return error.name; } })()`),
    'EvalError',
  );
  assert.equal(realm.evaluate('typeof AgentcommsEventsRealm.run'), 'function', 'the bundle is loaded');
});

test('ISO-b: every vector family runs identically in Node and in the bare realm', async (t) => {
  const files = readdirSync(VECTORS)
    .filter((name) => name.endsWith('.json'))
    .sort();
  assert.ok(files.length > 0, 'no vector files found');
  for (const name of files) {
    await t.test(name, () => {
      const text = readFileSync(join(VECTORS, name), 'utf8');
      const file = JSON.parse(text) as VectorFile;
      assert.equal(typeof file.family, 'string', `${name} declares no family`);
      const runner = RUNNERS[file.family];
      assert.ok(runner, `${name}: no runner for the family "${file.family}" in test/realm/runners/index.ts`);
      const inNode = runner(library, file);
      assert.deepEqual(inNode.failures, [], `${name}, in Node`);
      assert.ok(inNode.results.length > 0, `${name}: no results`);
      const inRealm = realm.run(file.family, text);
      assert.deepEqual(JSON.parse(inRealm).failures, [], `${name}, in the realm`);
      assert.equal(inRealm, JSON.stringify(inNode), `${name}: the realm's results differ from Node's`);
    });
  }
});
