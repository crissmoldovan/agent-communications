#!/usr/bin/env node
/**
 * `pnpm test`: the root suite, then every package's suite, each of them run whatever failed before it.
 *
 * It was `node --test … && pnpm -r run test`. A failing root test then hid every package's result, and `pnpm -r`
 * stopped at the first failing package, so a cloud run showed one failure, and each further one cost another run of
 * about an hour: 0.26.1 needed two runs for what one would have shown. Now every suite runs, and the exit is 1 when
 * any failed, naming which.
 *
 * pnpm is run as it ran this script: `npm_execpath`, through this Node when it is a script, and by name otherwise
 * (through the shell on Windows, where it is a `.cmd`).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function pnpm(args) {
  const execPath = process.env.npm_execpath ?? '';
  if (/\.[cm]?js$/u.test(execPath))
    return spawnSync(process.execPath, [execPath, ...args], { cwd: ROOT, stdio: 'inherit' });
  if (execPath && /pnpm/iu.test(execPath)) return spawnSync(execPath, args, { cwd: ROOT, stdio: 'inherit' });
  return spawnSync('pnpm', args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
}

const suites = [
  {
    name: 'the root suite',
    result: spawnSync(
      process.execPath,
      ['--import', './test/helpers/loopback-seal-preload.mjs', '--test', 'test/**/*.test.mjs'],
      { cwd: ROOT, stdio: 'inherit' },
    ),
  },
];
suites.push({
  name: "the packages' suites",
  result: pnpm(['-r', '--no-bail', '--filter', './packages/**', '--filter', './apps/**', 'run', 'test']),
});

const failed = suites.filter(({ result }) => result.status !== 0);
for (const { name, result } of failed) {
  const why = result.error ? result.error.message : `exit ${result.status ?? result.signal}`;
  console.error(`::error::${name} failed (${why}); every suite still ran, so the output above has each failure`);
}
process.exit(failed.length === 0 ? 0 : 1);
