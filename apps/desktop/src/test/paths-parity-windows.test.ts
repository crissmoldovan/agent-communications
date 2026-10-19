// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { resolvePaths } from '../../../../packages/core/src/paths.ts';

/*
 * The Windows cases of the fixture the Rust port is tested against (`src-tauri/tests/paths_parity.rs`), checked
 * against core's own `resolvePaths` on any host: core joins and resolves with `node:path`, so here `node:path` is
 * answered by `path.win32`, as a Windows host answers it. A change to core's Windows rules fails this test.
 */
vi.mock('node:path', async () => {
  const { win32 } = await vi.importActual<typeof import('node:path')>('node:path');
  return { ...win32, default: win32 };
});

interface Case {
  name: string;
  platform: string;
  home: string;
  env: Record<string, string>;
  expected: { configDir: string; stateDir: string; dataDir: string; secretsDir: string };
}

const fixture: { cases: Case[] } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../src-tauri/tests/fixtures/resolve-paths.json', import.meta.url)), 'utf8'),
);

describe('the folder rules on Windows', () => {
  it('resolvePaths gives every recorded Windows case', () => {
    const windows = fixture.cases.filter((testCase) => testCase.platform === 'win32');
    expect(windows.length).toBeGreaterThanOrEqual(10);
    for (const testCase of windows) {
      const paths = resolvePaths({ env: testCase.env, platform: 'win32', home: testCase.home });
      expect(
        { configDir: paths.configDir, stateDir: paths.stateDir, dataDir: paths.dataDir, secretsDir: paths.secretsDir },
        testCase.name,
      ).toEqual(testCase.expected);
    }
  });
});
