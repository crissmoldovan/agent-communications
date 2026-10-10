import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { runStrictMutationChild } from './support/strict-mutation-child.ts';

test('E5 mutation runner: a non-exiting child fails by timeout rather than becoming mutant evidence', async () => {
  const startedAt = performance.now();
  await assert.rejects(
    runStrictMutationChild({
      command: process.execPath,
      args: ['--eval', 'setInterval(() => undefined, 1_000)'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 100,
    }),
    /timed out after 100ms/u,
  );
  assert.ok(performance.now() - startedAt < 1_000, 'the runner bounds a hung child promptly');
});
