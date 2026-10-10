#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'apps/desktop/test/mutations/manifest.json'), 'utf8'));
const args = process.argv.slice(2);
const selected =
  args[0] === '--case'
    ? manifest.cases.filter((item) => item.id === args[1])
    : args[0] === '--group'
      ? manifest.cases.filter((item) => item.group === args[1])
      : args[0] === '--all'
        ? manifest.cases
        : [];
if (selected.length === 0) {
  process.stderr.write('Usage: run.mjs --case <id> | --group <group> | --all\n');
  process.exitCode = 1;
} else {
  for (const item of selected) {
    const temp = await mkdtemp(join(tmpdir(), 'desktop-mutation-'));
    try {
      const excluded = new Set(['.git', '.pnpm-store', '.superpowers', '.tmp', 'node_modules', 'target', 'dist']);
      for (const name of await readdir(root)) {
        if (excluded.has(name)) continue;
        await cp(join(root, name), join(temp, name), {
          recursive: true,
          filter: (source) => !source.split(sep).some((part) => excluded.has(part)),
        });
      }
      if (item.test.includes('/e2e/')) {
        const kind = process.platform === 'win32' ? 'junction' : 'dir';
        await symlink(join(root, 'node_modules'), join(temp, 'node_modules'), kind);
        await symlink(join(root, 'apps/desktop/node_modules'), join(temp, 'apps/desktop/node_modules'), kind);
      }
      const target = resolve(temp, item.mutation.file);
      if (!target.startsWith(`${temp}${sep}`) || isAbsolute(item.mutation.file) || item.mutation.file.includes('..')) {
        throw new Error(`${item.id}: mutation file escapes temporary copy`);
      }
      const original = await readFile(target, 'utf8');
      if (original.split(item.mutation.find).length !== 2) {
        throw new Error(`${item.id}: mutation text must occur exactly once`);
      }
      const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, encoding: 'utf8' }).trim();
      const childEnv = { ...process.env, NODE_OPTIONS: '', GIT_DIR: gitDir, GIT_WORK_TREE: temp };
      delete childEnv.DESKTOP_PROBE_BINARY;
      // The copy excludes target/, so a packaged probe would rebuild every dependency for the baseline and again for
      // the mutant. They share one dedicated cache instead: not the checkout's own target/, which keeps its real build.
      if (item.test.includes('/e2e/')) {
        childEnv.CARGO_TARGET_DIR = join(root, 'apps/desktop/src-tauri/target/desktop-mutations');
        // The copy's node_modules are links to the checkout's. pnpm's check before `exec` and `run` would try to
        // reinstall through them, and refuses to; the checkout's install is the one being tested.
        childEnv.npm_config_verify_deps_before_run = 'false';
        childEnv.pnpm_config_verify_deps_before_run = 'false';
      }
      for (const key of Object.keys(childEnv)) {
        if (key.startsWith('NODE_TEST')) delete childEnv[key];
      }
      const testArgs = ['--test', `--test-name-pattern=${item.testName}`, item.test];
      const baseline = spawnSync(process.execPath, testArgs, {
        cwd: temp,
        encoding: 'utf8',
        env: childEnv,
      });
      if (baseline.status !== 0 || baseline.error || !/^# pass 1$/m.test(baseline.stdout)) {
        throw new Error(`${item.id}: named test is not green before mutation\n${baseline.stderr}\n${baseline.stdout}`);
      }
      await writeFile(target, original.replace(item.mutation.find, item.mutation.replace));
      const result = spawnSync(process.execPath, testArgs, {
        cwd: temp,
        encoding: 'utf8',
        env: childEnv,
      });
      if (result.status === 0 || !/^# fail 1$/m.test(result.stdout)) {
        throw new Error(`${item.id}: mutant did not fail its named test\n${result.stderr}\n${result.stdout}`);
      }
      if (result.error) throw result.error;
      process.stdout.write(`mutation ${item.id} failed its named test (exit ${result.status})\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}
