import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// desktop-mutation: desktop-windows-pre-read-refusal
test('windows-support-pre-read-refusal: public client rejects before profile resolution', async () => {
  const text = await readFile(new URL('../src-tauri/src/control/client.rs', import.meta.url), 'utf8');
  const entry = text.slice(text.indexOf('pub fn request('));
  assert.match(
    entry,
    /#\[cfg\(windows\)\]\s*\{\s*let _ = operation;\s*Self::windows_pre_read_refusal\(&self\.profile\)\s*\}/,
  );
  assert.match(
    text,
    /pub fn windows_pre_read_refusal\(\s*_profile: &DaemonProfile,\s*\) -> Result<AuthenticatedReply, ControlError> \{\s*Err\(ControlError::windows_unavailable\(\)\)/,
  );
});
