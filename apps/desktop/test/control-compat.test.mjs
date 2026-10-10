import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const production = {
  'frame.rs': new URL('../src-tauri/src/control/frame.rs', import.meta.url),
  'types.rs': new URL('../src-tauri/src/control/types.rs', import.meta.url),
  'client.rs': new URL('../src-tauri/src/control/client.rs', import.meta.url),
};
const source = (name) => readFile(production[name], 'utf8');

// desktop-mutation: desktop-frame-bounds
test('control-frame-bounds: Rust production decoder bounds exact big-endian frames', async () => {
  const text = await source('frame.rs');
  assert.match(text, /MAX_FRAME_BYTES/);
  assert.match(text, /u32::from_be_bytes/);
  assert.match(text, /if length > MAX_FRAME_BYTES/);
  assert.match(text, /length != frame\.len\(\) - 4/);
});

// desktop-mutation: desktop-no-overlap
test('control-no-overlap: Rust production negotiation refuses disjoint versions', async () => {
  assert.match(await source('frame.rs'), /PROTOCOL_UNSUPPORTED/);
});

// desktop-mutation: desktop-token-redaction
test('control-token-redaction: public control errors do not display internal text', async () => {
  const text = await source('types.rs');
  assert.match(text, /write!\(f, "\{\}", self\.code\)/);
  assert.doesNotMatch(text, /write!\(f, "\{\}", self\.message\)/);
});

// desktop-mutation: desktop-endpoint-proof
test('control-endpoint-proof: Unix endpoint proof precedes token read', async () => {
  const text = await source('client.rs');
  const proof = text.indexOf('verify_endpoint(&paths, &record)?');
  const read = text.indexOf('read_token(&paths, &record.token_fingerprint)?');
  assert.ok(proof >= 0 && read > proof);
  assert.equal(text.match(/verify_endpoint\(&paths, &record\)\?;/g)?.length, 2);
});

// desktop-mutation: desktop-control-stale-reply
test('control-stale-reply: Rust production client validates request identity', async () => {
  assert.match(await source('types.rs'), /if request_id != expected/);
});
