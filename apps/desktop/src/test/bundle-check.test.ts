// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { prepaintSource } from '../theme.ts';

/*
 * The bundle check (DA7) against a built app of the test's own: the real `package.json` and `tauri.conf.json`, and a
 * `dist/` holding the pre-paint script, one chunk and one stylesheet, which it passes. Then one Laya artifact at a time
 * is planted, and each is refused (E2 Task 11, DA16): no model, runtime, worker or Laya file ever enters the app.
 */

const APP = fileURLToPath(new URL('../../', import.meta.url));

type BundleProblems = (options: { app: string }) => string[];
const { bundleProblems } = (await import(pathToFileURL(join(APP, 'scripts', 'bundle-check.mjs')).href)) as {
  bundleProblems: BundleProblems;
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A built app the bundle check passes. */
function builtApp(): string {
  const app = mkdtempSync(join(tmpdir(), 'agentcomms-bundle-'));
  roots.push(app);
  cpSync(join(APP, 'package.json'), join(app, 'package.json'));
  mkdirSync(join(app, 'src-tauri'));
  cpSync(join(APP, 'src-tauri', 'tauri.conf.json'), join(app, 'src-tauri', 'tauri.conf.json'));
  mkdirSync(join(app, 'dist', 'assets'), { recursive: true });
  writeFileSync(
    join(app, 'dist', 'index.html'),
    `<!doctype html><html><head><script>${prepaintSource()}</script><script type="module" src="/assets/index.js"></script><link rel="stylesheet" href="/assets/index.css"></head><body><div id="root"></div></body></html>`,
  );
  writeFileSync(join(app, 'dist', 'assets', 'index.js'), 'export const app = "Agent Comms";\n');
  writeFileSync(join(app, 'dist', 'assets', 'index.css'), 'body{margin:0}\n');
  expect(bundleProblems({ app })).toEqual([]);
  return app;
}

/** Writes `text` at `path` below `app`, and gives back what the bundle check says then. */
function planted(app: string, path: string, text: string | Buffer): string[] {
  const target = join(app, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  return bundleProblems({ app });
}

it('E2 desktop Laya contract: the bundle check refuses every model, runtime, worker or Laya file', () => {
  const app = builtApp();
  for (const path of [
    'dist/assets/laya.onnx',
    'dist/assets/laya.onnx.data',
    'dist/assets/tokenizer.json',
    'dist/assets/tokenizer_config.json',
    'dist/assets/laya_config.json',
    'dist/assets/onnxruntime_binding.node',
    'dist/assets/libonnxruntime.1.30.0.dylib',
    'dist/assets/libonnxruntime.so',
    'dist/assets/libonnxruntime.so.1.30.0',
    'dist/assets/onnxruntime.dll',
    'dist/assets/laya-manifest.json',
    'dist/assets/laya-runtime.json',
    'dist/assets/laya-enablement-disclosures.json',
    'dist/assets/laya-worker.mjs',
    'dist/laya-worker.mjs',
    'dist/models/laya-en-onnx-v1/laya.onnx',
    'dist/assets/runtime/tokenizer/tokenizer.json',
  ]) {
    const problems = planted(app, path, Buffer.from([0x08, 0x01, 0x12, 0x00]));
    expect(
      problems.filter((problem) => problem.includes(path) && problem.includes('Laya')),
      path,
    ).toHaveLength(1);
    rmSync(join(app, path));
    rmSync(join(app, 'dist', 'models'), { recursive: true, force: true });
    rmSync(join(app, 'dist', 'assets', 'runtime'), { recursive: true, force: true });
    expect(bundleProblems({ app }), `${path} removed`).toEqual([]);
  }
});

it('E2 desktop Laya contract: the bundle check refuses a chunk that names the Laya runtime or holds its worker', () => {
  const app = builtApp();
  const chunk = join(app, 'dist', 'assets', 'index.js');
  const clean = readFileSync(chunk, 'utf8');
  for (const text of [
    'import { Laya } from "@receptron/laya";',
    'const ort = require("onnxruntime-node");',
    'import * as ort from "onnxruntime-web";',
    'import { Tokenizer } from "@huggingface/tokenizers";',
    'new URL("./laya-worker.mjs", import.meta.url)',
    'class LayaWorkerProtocolError extends Error {}',
    'const profile = "(version 1) (allow default) (deny network*)";',
  ]) {
    const problems = planted(app, 'dist/assets/index.js', `${clean}${text}\n`);
    expect(
      problems.filter((problem) => problem.includes('dist/assets/index.js') && problem.includes('Laya')),
      text,
    ).toHaveLength(1);
    writeFileSync(chunk, clean);
  }
  // A stylesheet or the page itself is read the same way.
  expect(planted(app, 'dist/assets/index.css', 'body{}/* onnxruntime */').some((p) => p.includes('index.css'))).toBe(
    true,
  );
});

it('E2 desktop Laya contract: the app may not depend on the Laya runtime, the events daemon or their packages', () => {
  const app = builtApp();
  const manifest = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as Record<string, unknown>;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of [
      '@agentcomms/events-laya-runtime',
      '@agentcomms/events-daemon',
      '@receptron/laya',
      'onnxruntime-node',
      'onnxruntime-web',
      '@huggingface/tokenizers',
    ]) {
      const changed = {
        ...manifest,
        [field]: { ...(manifest[field] as Record<string, string> | undefined), [name]: 'workspace:*' },
      };
      writeFileSync(join(app, 'package.json'), `${JSON.stringify(changed, null, 2)}\n`);
      expect(
        bundleProblems({ app }).filter((problem) => problem.includes(name) && problem.includes(field)),
        `${field} ${name}`,
      ).toHaveLength(1);
    }
  }
  cpSync(join(APP, 'package.json'), join(app, 'package.json'));
  expect(bundleProblems({ app })).toEqual([]);
});
