import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// desktop-mutation: desktop-launch-docs
test('desktop-launch-docs', async () => {
  for (const relative of ['../README.md', '../RELEASE_NOTES.md', '../../../docs/RELEASING.md']) {
    const text = await readFile(new URL(relative, import.meta.url), 'utf8');
    for (const phrase of [
      'SHA-256',
      'SHA256SUMS',
      'shasum -a 256',
      'Get-FileHash',
      'compare',
      'macOS',
      'System Settings',
      'Privacy & Security',
      'Open Anyway',
      'about an hour',
      'login password',
      'Windows protected your PC',
      'More info',
      'Run anyway',
      'SmartScreen',
      'Enterprise policy',
      'Smart App Control',
      'separate daemon',
      'no in-app updater',
      'no Linux',
      'Developer ID',
      'notarise',
      'staple',
      'code-signing',
    ])
      assert.ok(text.includes(phrase), `${relative} misses ${phrase}`);
  }
  const notes = await readFile(new URL('../RELEASE_NOTES.md', import.meta.url), 'utf8');
  assert.match(notes, /owner and.*named colleagues/);
  assert.match(notes, /cannot run version 1/);
  const notices = await readFile(new URL('../THIRD_PARTY_LICENSES', import.meta.url), 'utf8');
  for (const dependency of [
    '@cueplusplus/tokens@0.20.1',
    '@cueplusplus/theme-cue@1.1.1',
    '@cueplusplus/ui@0.20.1',
    'react@',
    'react-dom@',
    'tauri@',
  ]) {
    assert.ok(notices.includes(dependency), `notice missing for ${dependency}`);
  }
  assert.match(notices, /pnpm-lock\.yaml/);
  assert.match(notices, /Cargo\.lock/);
  assert.match(notices, /ARCHIVES WITHOUT LICENCE TEXT/);
  assert.match(notices, /must be obtained and reviewed before distribution/);
});
