import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const production = {
  'preferences.rs': new URL('../src-tauri/src/preferences.rs', import.meta.url),
  'supervisor.rs': new URL('../src-tauri/src/supervisor.rs', import.meta.url),
};
const source = (name) => readFile(production[name], 'utf8');

// desktop-mutation: desktop-daemon-profile-drift
test('daemon-profile-drift: launch uses exact executable and fixed run argv', async () => {
  const text = await source('supervisor.rs');
  assert.match(text, /Command::new\(&profile\.executable\)/);
  assert.match(text, /\.arg\("run"\)/);
  assert.match(text, /\.arg\("--state-dir"\)/);
  assert.match(text, /\.arg\("--config-dir"\)/);
});

// desktop-mutation: desktop-preferences-private
test('preferences-private: preference file owner and mode are verified', async () => {
  const text = await source('preferences.rs');
  assert.match(text, /metadata\.uid\(\) != unsafe \{ libc::geteuid\(\) \}/);
  assert.match(text, /metadata\.mode\(\) & 0o777 != 0o600/);
});

// desktop-mutation: desktop-preferences-symlink-reparse
test('preferences-symlink-reparse: preferences reject symlink paths', async () => {
  assert.match(await source('preferences.rs'), /file_type\(\)\.is_symlink\(\)/);
});

// desktop-mutation: desktop-preferences-atomic-recovery
test('preferences-atomic-recovery: preferences write complete tmp and rename', async () => {
  const text = await source('preferences.rs');
  assert.match(text, /serde_json::from_slice/);
  assert.match(text, /file\.sync_all\(\)/);
  assert.match(text, /libc::renameat\(/);
});

// desktop-mutation: desktop-preferences-lock
test('preferences-lock: preference replacement takes a sibling exclusive lock', async () => {
  const text = await source('preferences.rs');
  assert.match(text, /let lock = open_private_file\(&parent, &lock_name, libc::O_RDWR, 0o600, true\)\?/);
  assert.match(text, /libc::flock\(lock\.as_raw_fd\(\), libc::LOCK_EX\)/);
});
