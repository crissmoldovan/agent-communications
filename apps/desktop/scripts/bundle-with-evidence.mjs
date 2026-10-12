// One invocation builds and binds the fresh Vite graph to every byte of its packaged output.
// Audit never substitutes a later checkout dist/ graph for this accompaniment.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactInventory, cargoPlatforms, validateFrontendAssets } from './bundle-content-graph.mjs';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2).filter((arg, index) => index !== 0 || arg !== '--');
assert.equal(args[0], 'pnpm', 'only the declared local desktop build is supported');
assert.ok(args.includes('tauri:build'), 'expected desktop Tauri build');
const targetArg = args.indexOf('--target');
const rust = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
assert.equal(rust.status, 0, 'Rust target metadata unavailable');
const platform = targetArg < 0 ? rust.stdout.match(/^host: (.+)$/m)?.[1] : args[targetArg + 1];
assert.ok(platform, 'missing artifact target');
const target = resolve(
  process.env.CARGO_TARGET_DIR ?? join(desktop, 'src-tauri/target'),
  ...(targetArg < 0 ? [] : [platform]),
);
const evidence = join(target, 'release/desktop-artifact-evidence.json');
const dist = resolve(process.env.DESKTOP_DIST_DIR ?? join(desktop, 'dist'));
const graph = join(dist, 'desktop-build-graph.json');
// Explicit, bounded evidence targets; never delete an app or build directory.
await rm(evidence, { force: true });
await rm(graph, { force: true });
const buildId = randomUUID();
const built = spawnSync(args[0], args.slice(1), {
  cwd: fileURLToPath(new URL('../../../', import.meta.url)),
  env: { ...process.env, DESKTOP_BUILD_ID: buildId },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
assert.equal(built.status, 0, `desktop artifact build unavailable: ${built.error?.code ?? built.status}`);
const vite = JSON.parse(await readFile(graph, 'utf8'));
assert.equal(vite.buildId, buildId, 'build did not produce fresh frontend evidence');
await validateFrontendAssets(vite, dist);
await writeFile(
  evidence,
  JSON.stringify({
    version: 1,
    buildId,
    platforms: cargoPlatforms(platform),
    vite,
    artifacts: await artifactInventory(join(target, 'release/bundle')),
  }),
  { mode: 0o600 },
);
