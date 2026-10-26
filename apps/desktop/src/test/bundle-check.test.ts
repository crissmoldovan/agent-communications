// @vitest-environment node
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
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
  for (const file of ['tauri.conf.json', 'Cargo.toml', 'Cargo.lock', 'build.rs'])
    cpSync(join(APP, 'src-tauri', file), join(app, 'src-tauri', file));
  cpSync(join(APP, 'src-tauri', 'src'), join(app, 'src-tauri', 'src'), { recursive: true });
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

// E2 review round 1 (B5): every other way a file reaches the bundle. Tauri v2's configuration (tauri-utils 2.10) names
// files for the app, its installers and its packages in many places besides `resources` and `externalBin`, under
// camelCase keys and kebab-case aliases; a platform configuration file beside tauri.conf.json is merged into it.

/** The app's tauri.conf.json with one value set at a dotted path (each segment created if absent). */
function withConfig(app: string, path: string, value: unknown): string[] {
  const file = join(app, 'src-tauri', 'tauri.conf.json');
  const config = JSON.parse(readFileSync(join(APP, 'src-tauri', 'tauri.conf.json'), 'utf8')) as Record<string, unknown>;
  const keys = path.split('.');
  let node = config;
  for (const key of keys.slice(0, -1)) {
    node[key] ??= {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys.at(-1) as string] = value;
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  const problems = bundleProblems({ app });
  cpSync(join(APP, 'src-tauri', 'tauri.conf.json'), file);
  return problems;
}

it('E2 desktop Laya contract: the bundle check refuses every file route Tauri’s configuration has', () => {
  const app = builtApp();
  const routes: readonly [string, unknown][] = [
    ['bundle.resources', ['../../packages/events-daemon/laya-manifest.json']],
    ['bundle.externalBin', ['binaries/laya-worker']],
    ['bundle.licenseFile', 'LICENSE'],
    ['bundle.macOS.frameworks', ['libonnxruntime.dylib']],
    ['bundle.macOS.files', { 'Resources/model.bin': '../model.bin' }],
    ['bundle.macos.files', { 'Resources/model.bin': '../model.bin' }],
    ['bundle.macOS.dmg.background', 'background.png'],
    ['bundle.iOS.frameworks', ['ort']],
    ['bundle.iOS.template', 'project.yml'],
    ['bundle.linux.deb.files', { '/usr/share/agentcomms/model.bin': '../model.bin' }],
    ['bundle.linux.deb.changelog', 'CHANGELOG'],
    ['bundle.linux.deb.desktopTemplate', 'app.desktop'],
    ['bundle.linux.deb.postInstallScript', 'postinst.sh'],
    ['bundle.linux.deb.post-install-script', 'postinst.sh'],
    ['bundle.linux.rpm.files', { '/usr/share/agentcomms/model.bin': '../model.bin' }],
    ['bundle.linux.rpm.preRemoveScript', 'prerm.sh'],
    ['bundle.linux.appimage.files', { 'usr/share/model.bin': '../model.bin' }],
    ['bundle.linux.appimage.bundleMediaFramework', true],
    ['bundle.windows.webviewInstallMode', { type: 'fixedRuntime', path: './webview2/' }],
    ['bundle.windows.wix.fragmentPaths', ['fragment.wxs']],
    ['bundle.windows.wix.bannerPath', 'banner.bmp'],
    ['bundle.windows.nsis.installerHooks', 'hooks.nsh'],
    ['bundle.windows.nsis.install-icon', 'model.ico'],
    ['bundle.windows.nsis.customLanguageFiles', { English: 'en.nsh' }],
    ['bundle.icon', ['icons/icon.png', '../../packages/events-daemon/laya-manifest.json']],
    ['app.trayIcon', { iconPath: '../model.png' }],
    ['build.frontendDist', '../../packages/events-daemon/dist'],
    ['build.beforeBuildCommand', 'pnpm build && cp -r ../../packages/events-daemon/dist dist/assets'],
    ['build.beforeBundleCommand', 'cp model.onnx dist/assets'],
  ];
  for (const [path, value] of routes) {
    const problems = withConfig(app, path, value);
    expect(
      problems.filter((problem) => problem.startsWith('tauri.conf.json:')),
      `${path} = ${JSON.stringify(value)}`,
    ).toHaveLength(1);
  }
  // A webview the system installs carries no file of the repository's, and is no route.
  expect(withConfig(app, 'bundle.windows.webviewInstallMode', { type: 'downloadBootstrapper' })).toEqual([]);
  for (const file of ['tauri.macos.conf.json', 'tauri.linux.conf.json', 'tauri.windows.conf.json', 'Tauri.toml']) {
    const problems = planted(app, `src-tauri/${file}`, '{"bundle":{"macOS":{"files":{}}}}\n');
    expect(
      problems.filter((problem) => problem.includes(file)),
      file,
    ).toHaveLength(1);
    rmSync(join(app, 'src-tauri', file));
  }
  expect(bundleProblems({ app })).toEqual([]);
});

it('E2 desktop Laya contract: the bundle check refuses an ONNX Runtime crate in the app’s Cargo manifest or lock', () => {
  const app = builtApp();
  const manifest = join(app, 'src-tauri', 'Cargo.toml');
  const lock = join(app, 'src-tauri', 'Cargo.lock');
  const clean = { manifest: readFileSync(manifest, 'utf8'), lock: readFileSync(lock, 'utf8') };
  for (const addition of [
    '\n[dependencies.ort]\nversion = "2.0.0-rc.10"\n',
    '\n[target.\'cfg(target_os = "macos")\'.dependencies]\nonnxruntime = "0.0.14"\n',
    '\n[dev-dependencies]\nort-sys = "2"\n',
    '\n[build-dependencies]\nmodel = { package = "ort", version = "2" }\n',
  ]) {
    writeFileSync(manifest, `${clean.manifest}${addition}`);
    expect(
      bundleProblems({ app }).filter((problem) => problem.startsWith('src-tauri/Cargo.toml')),
      addition,
    ).toHaveLength(1);
  }
  writeFileSync(manifest, clean.manifest);
  // A crate that brings ONNX Runtime in as a dependency of its own is in the lock, not the manifest.
  writeFileSync(lock, `${clean.lock}\n[[package]]\nname = "ort"\nversion = "2.0.0"\n`);
  expect(bundleProblems({ app }).filter((problem) => problem.startsWith('src-tauri/Cargo.lock'))).toHaveLength(1);
  writeFileSync(lock, clean.lock);
  expect(bundleProblems({ app })).toEqual([]);
});

it('E2 desktop Laya contract: the bundle check refuses a model-like file the Rust code embeds', () => {
  const app = builtApp();
  const tray = join(app, 'src-tauri', 'src', 'tray.rs');
  const clean = readFileSync(tray, 'utf8');
  for (const embed of [
    'const MODEL: &[u8] = include_bytes!("../models/laya.onnx");',
    'const DATA: &[u8] = include_bytes!(\n    "../models/laya.onnx.data"\n);',
    'const TOKENIZER: &str = include_str!("../assets/tokenizer-Dx3b9AqZ.json");',
    'const WORKER: &str = include_str!(concat!(env!("OUT_DIR"), "/laya-worker.mjs"));',
    'const NATIVE: &[u8] = include_bytes!["../lib/onnxruntime_binding.node"];',
  ]) {
    writeFileSync(tray, `${clean}\n${embed}\n`);
    expect(
      bundleProblems({ app }).filter((problem) => problem.startsWith('src-tauri/src/tray.rs')),
      embed,
    ).toHaveLength(1);
  }
  writeFileSync(tray, clean);
  expect(bundleProblems({ app })).toEqual([]);
});

it('E2 desktop Laya contract: the bundle check refuses each Laya file under its Vite-hashed name', () => {
  const app = builtApp();
  for (const path of [
    'dist/assets/laya.onnx-BfK2a9Xc.data',
    'dist/assets/tokenizer-Dx3b9AqZ.json',
    'dist/assets/tokenizer_config-C9-x_2Lm.json',
    'dist/assets/laya_config-a1B2c3D4.json',
    'dist/assets/laya-manifest-Q8w-e7Rt.json',
    'dist/assets/laya-runtime-Zz9Yy8Xx.json',
    'dist/assets/laya-enablement-disclosures-Pq1Rs2Tu.json',
    'dist/assets/laya-worker-Bk-3a9Qz.js',
    'dist/assets/worker-boundary-probe-1a2B3c4D.js',
  ]) {
    const problems = planted(app, path, 'x');
    expect(
      problems.filter((problem) => problem.includes(path) && problem.includes('Laya')),
      path,
    ).toHaveLength(1);
    rmSync(join(app, path));
  }
  // An ordinary chunk whose name merely has a hash is the app's own.
  expect(planted(app, 'dist/assets/settings-BU2dAu9v.js', 'export {};\n')).toEqual([]);
});

it('E2 desktop Laya contract: the bundle check refuses a built file over its size limit without reading it', () => {
  const app = builtApp();
  const path = 'dist/assets/index-pmfPCMT4.js';
  const target = join(app, path);
  writeFileSync(target, '');
  // Sparse, so it takes no disk; unreadable where permissions apply, so a check that read it would throw.
  truncateSync(target, 3 * 1024 * 1024 + 1);
  if (process.platform !== 'win32') chmodSync(target, 0o000);
  const problems = bundleProblems({ app });
  expect(problems.filter((problem) => problem.startsWith(path) && problem.includes('over'))).toHaveLength(1);
  if (process.platform !== 'win32') chmodSync(target, 0o600);
  rmSync(target);
  expect(bundleProblems({ app })).toEqual([]);
});

it('the bundle check refuses a font inlined as a data: URI, which the content policy would refuse', () => {
  const app = builtApp();
  const face = (src: string) => `@font-face{font-family:"Inter Variable";src:url(${src})format("woff2-variations")}\n`;
  // A face served from the app's own assets, as Vite writes it, passes.
  expect(planted(app, 'dist/assets/index.css', face('/assets/inter-latin-wght-normal-Dx4kXJAl.woff2'))).toEqual([]);
  const problems = planted(app, 'dist/assets/index.css', face('data:font/woff2;base64,d09GMgABAAAAAA'));
  expect(problems).toEqual([
    'dist/assets/index.css inlines a font as a data: URI, which the content policy refuses: it must be a file',
  ]);
  // A data: image elsewhere in the stylesheet is the policy's `img-src data:`, and is not a font.
  expect(planted(app, 'dist/assets/index.css', 'a{background:url("data:image/svg+xml,%3Csvg%3E")}\n')).toEqual([]);
});
