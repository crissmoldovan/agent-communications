import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));

async function runChecker(): Promise<{ readonly code: number | null; readonly output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        'scripts/verify-events-phase-e2-tests.mjs',
      ],
      { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
}

test('laya scope: completed checker accepts the Task 3 proof fragment', async () => {
  const result = await runChecker();
  assert.equal(result.code, 0, result.output);
});

test('laya scope: the checker keeps the Laya kind vocabulary owned by lifecycle', async () => {
  const result = await runChecker();
  assert.equal(result.code, 0, result.output);
});
