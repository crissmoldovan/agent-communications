import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// desktop-mutation: desktop-no-secret-generic-dispatch
test('native-boundary: the generated enum excludes the complete D2 operation set', async () => {
  const source = await readFile(new URL('../scripts/b3-contract.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('const operations = registry.filter((operation) => !secret.includes(operation));'));
});

// desktop-mutation: desktop-approval-authoritative-preview
test('native-boundary: the native approval session binds the fetched digest', async () => {
  const source = await readFile(new URL('../src-tauri/src/commands/approval.rs', import.meta.url), 'utf8');
  assert.ok(source.includes('if reply["digest"] != input.digest || reply["challenge"]["digest"] != input.digest {'));
});

// desktop-mutation: desktop-preview-controls
test('native-boundary: the native preview neutralises controls before display', async () => {
  const source = await readFile(new URL('../src-tauri/src/preview.rs', import.meta.url), 'utf8');
  assert.ok(source.includes('.filter(|c| !dangerous(*c))'));
});

// desktop-mutation: desktop-untrusted-result-raw-forward
test('native-boundary: the native result boundary sanitises every text segment', async () => {
  const source = await readFile(new URL('../src-tauri/src/untrusted_result.rs', import.meta.url), 'utf8');
  assert.ok(source.includes('let clean = neutralise(text).replace(\'<\', "&lt;").replace(\'>\', "&gt;");'));
});

// desktop-mutation: desktop-untrusted-result-bounds
test('native-boundary: the native result boundary limits text before IPC', async () => {
  const source = await readFile(new URL('../src-tauri/src/untrusted_result.rs', import.meta.url), 'utf8');
  assert.ok(source.includes('let (text, text_cut) = safe_text(text, MAX_SEGMENT_BYTES.min(*budget));'));
});

// desktop-mutation: desktop-settings-autostart-no-spawn
test('native-boundary: the persisted login preference never starts a daemon', async () => {
  const source = await readFile(new URL('../src-tauri/src/supervisor.rs', import.meta.url), 'utf8');
  assert.ok(source.includes('pub fn startup(&self) -> SupervisorStatus {\n        self.status()\n    }'));
});

// desktop-mutation: desktop-b3-stale-rust-type
test('native-boundary: schema-derived Rust numeric DTOs consume the B3 vectors', async () => {
  const source = await readFile(new URL('../scripts/b3-contract.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("integer: 'i64'"));
});

// desktop-mutation: desktop-schema-scope-native
test('native-boundary: request identities bind without optional UI scope', async () => {
  const source = await readFile(new URL('../src-tauri/src/control/b3_contract.rs', import.meta.url), 'utf8');
  assert.ok(
    source.includes('args.get(*field)\n                .is_some_and(|expected| result.get(*field) != Some(expected))'),
  );
});

// desktop-mutation: desktop-generic-approve-refusal
test('native-boundary: the generic command cannot execute approval', async () => {
  const source = await readFile(new URL('../src-tauri/src/control/b3_contract.rs', import.meta.url), 'utf8');
  assert.ok(source.includes('NonSecretOperation::Approve | NonSecretOperation::ApprovalView'));
});
