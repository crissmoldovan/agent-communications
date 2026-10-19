// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolvePaths } from '../../../../packages/core/src/paths.ts';

/*
 * The fixture the Rust port is tested against (`src-tauri/tests/paths_parity.rs`) holds what core's own `resolvePaths`
 * gives. Here it is checked against core itself, so a change to core's rules fails this test rather than leaving the
 * port to agree with a stale record. POSIX cases only here: core joins with the host's separator, so a Windows host
 * cannot give a POSIX case's answer. The Windows cases are `paths-parity-windows.test.ts`'s, with `node:path` answered
 * as a Windows host answers it.
 */

interface Case {
  name: string;
  platform: 'linux' | 'darwin' | 'win32';
  home: string;
  env: Record<string, string>;
  expected: { configDir: string; stateDir: string; dataDir: string; secretsDir: string };
}

const fixture: { cases: Case[] } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../src-tauri/tests/fixtures/resolve-paths.json', import.meta.url)), 'utf8'),
);

describe('the folder rules', () => {
  it.skipIf(process.platform === 'win32')('resolvePaths gives every recorded POSIX case', () => {
    const posix = fixture.cases.filter((testCase) => testCase.platform !== 'win32');
    expect(posix.length).toBeGreaterThanOrEqual(10);
    for (const testCase of posix) {
      const paths = resolvePaths({ env: testCase.env, platform: testCase.platform, home: testCase.home });
      expect(
        { configDir: paths.configDir, stateDir: paths.stateDir, dataDir: paths.dataDir, secretsDir: paths.secretsDir },
        testCase.name,
      ).toEqual(testCase.expected);
    }
  });
});
