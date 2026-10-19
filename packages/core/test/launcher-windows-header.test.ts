import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { launcherPaths, writeLauncher } from '../src/launcher.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * A contract another program reads: the desktop app finds the Node a Windows installation runs its launchers with on
 * the second line of core's launcher, `<data>/launch/core` — Windows keeps no managed receipt that records it. The
 * reader is `windows_node_from_launcher` in `apps/desktop/src-tauri/src/launchers.rs`, which matches this same pattern
 * and parses the quoted path as JSON. Change that line's words, or how the path is written there, and the app falls
 * back to whatever `node.exe` is first on PATH: change both together.
 */

const HEADER = /^\/\/ updates; do not edit\. Started by ("(?:[^"\\]|\\.)*") with this file as its first word/;

test('the Windows launcher names its Node on its second line, as JSON', async () => {
  for (const node of ['C:\\Program Files\\nodejs\\node.exe', 'D:\\tools\\node v22\\node.exe']) {
    for (const name of ['core', 'events-daemon']) {
      const data = tempDir('comms-launcher-header-');
      await writeLauncher(data, name, node, { platform: 'win32' });
      const lines = readFileSync(launcherPaths(data, name).launcher, 'utf8').split('\n');
      const match = HEADER.exec(lines[1] ?? '');
      assert.ok(match, `${name}: line 2 is ${JSON.stringify(lines[1])}`);
      assert.equal(JSON.parse(match[1] as string), node, `${name}: the path the app starts launchers with`);
    }
  }
});
