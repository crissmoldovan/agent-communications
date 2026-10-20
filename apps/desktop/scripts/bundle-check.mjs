#!/usr/bin/env node
/**
 * What the built app may hold (desktop design DA7, plan "Where the design is silent" 12): run after `vite build`.
 *
 * - **No external binary and no resources** in the bundle: the app drives what is already installed, and ships nothing
 *   else (DA2, "no bundled daemon").
 * - **`dist/` holds only `index.html` and `assets/`:** nothing the bundler did not make.
 * - **Exactly one inline script,** the pre-paint script, and its hash is in the content policy's `script-src`. Any
 *   other inline script would be refused by the policy at run time, and so would this one if its hash drifted.
 * - **No `http(s)://` in the HTML or the CSS:** nothing remote is loaded. Two kinds of text are not loads and are
 *   left out first: comments (Tailwind's licence banner names its home page) and an XML namespace inside a `data:`
 *   URI (`xmlns='http://www.w3.org/2000/svg'`), which is an identifier the image declares, never fetched.
 * - **Nothing of Laya, the events service's local judge** (E2 Task 11, DA16): no model, tokenizer or model
 *   configuration, no native library, none of the events daemon's reviewed Laya assets, no worker, no file that names
 *   its runtime's packages or holds its worker, and no dependency on the Laya runtime, the events daemon or their
 *   packages. The daemon owns Laya, its downloads and its worker; the app only shows its status.
 * - **No other way in** (E2 review round 1): no file route of Tauri v2's configuration but the app's own `dist/`,
 *   icons, Info.plist and entitlements, and no platform configuration file merged beside it; no ONNX Runtime crate in
 *   the Cargo manifest or lock; no model-like file embedded by the Rust code; each Laya name refused under its
 *   Vite-hashed form too; and no built file over a size limit, which is refused by its size, unread.
 *
 * Prints `desktop bundle check: OK`, or every problem and exits 1.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));

/**
 * The largest file the built app may hold: the app's largest chunk is under 1 MB, and each of the model's three large
 * files is over 3 MiB. A file over it is refused by its size, before it is read.
 */
const BUILT_FILE_LIMIT_BYTES = 3 * 1024 * 1024;

/** A file only Laya is made of, by its name: what it is, for the problem that names it. */
const LAYA_FILES = [
  [/\.onnx(?:\.data)?$/i, 'a model file'],
  [/(?:^|\/)tokenizer(?:_config)?\.json$/i, "a model's tokenizer"],
  [/(?:^|\/)laya_config\.json$/i, "a model's configuration"],
  [/\.(?:node|dylib|dll)$|\.so(?:\.\d+)*$/i, 'a native library'],
  [/(?:^|\/)laya-(?:manifest|runtime|enablement-disclosures)\.json$/i, "one of the events daemon's reviewed assets"],
  [/(?:^|\/)(?:laya-worker|worker-main|worker-boundary-probe|worker-runtime)\.[cm]?[jt]s$/i, 'the worker'],
];

/** What a file that names Laya's runtime, or holds its worker, has in it. */
const LAYA_TEXT = [
  ['@receptron/laya', /@receptron\/laya/],
  ['onnxruntime', /onnxruntime/i],
  ['@huggingface/tokenizers', /@huggingface\/tokenizers/],
  ["the worker's entry", /laya-worker|worker-boundary-probe/],
  ["the worker's protocol", /LayaWorkerProtocolError/],
  ["the worker's sandbox profile", /\(deny network\*\)/],
];

/**
 * The names a file had before Vite hashed it (`<name>-<hash><ext>`), one for each `-` that may begin the hash, so each
 * pattern above refuses a hashed name too: `laya.onnx-<hash>.data`, `tokenizer-<hash>.json`, `laya-worker-<hash>.js`.
 */
function unhashedNames(path) {
  const slash = path.lastIndexOf('/');
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return [];
  const stem = base.slice(0, dot);
  const names = [];
  for (let at = stem.indexOf('-'); at > 0; at = stem.indexOf('-', at + 1))
    if (/^[A-Za-z0-9_-]{6,}$/.test(stem.slice(at + 1)))
      names.push(`${path.slice(0, slash + 1)}${stem.slice(0, at)}${base.slice(dot)}`);
  return names;
}

/** The Laya file `path` is, under its own name or the name Vite hashed, or undefined. */
function layaFile(path) {
  return LAYA_FILES.find(([pattern]) => [path, ...unhashedNames(path)].some((name) => pattern.test(name)));
}

/**
 * Every route by which Tauri v2's configuration puts a file into the app, its installers or its packages
 * (tauri-utils 2.10's `BundleConfig`, `MacConfig`, `DmgConfig`, `IosConfig`, `LinuxConfig` and its `deb`, `rpm` and
 * `appimage`, `WindowsConfig` and its `wix` and `nsis`), as dotted paths whose keys are compared without case, `-`
 * or `_`, so a kebab-case alias or `macos` is the same route. `resources` and `externalBin` are refused above; the
 * app sets none of these.
 */
const FILE_ROUTES = [
  'bundle.licenseFile',
  'bundle.macOS.frameworks',
  'bundle.macOS.files',
  'bundle.macOS.dmg.background',
  'bundle.iOS.frameworks',
  'bundle.iOS.template',
  'bundle.iOS.infoPlist',
  'bundle.linux.deb.files',
  'bundle.linux.deb.changelog',
  ...['deb', 'rpm'].flatMap((format) =>
    ['desktopTemplate', 'preInstallScript', 'postInstallScript', 'preRemoveScript', 'postRemoveScript'].map(
      (key) => `bundle.linux.${format}.${key}`,
    ),
  ),
  'bundle.linux.rpm.files',
  'bundle.linux.appimage.files',
  'bundle.linux.appimage.bundleMediaFramework',
  'bundle.windows.wix.template',
  'bundle.windows.wix.fragmentPaths',
  'bundle.windows.wix.bannerPath',
  'bundle.windows.wix.dialogImagePath',
  'bundle.windows.nsis.template',
  'bundle.windows.nsis.headerImage',
  'bundle.windows.nsis.sidebarImage',
  'bundle.windows.nsis.installerIcon',
  'bundle.windows.nsis.installIcon',
  'bundle.windows.nsis.uninstallerIcon',
  'bundle.windows.nsis.uninstallerHeaderImage',
  'bundle.windows.nsis.customLanguageFiles',
  'bundle.windows.nsis.installerHooks',
];
const routeKey = (path) => path.toLowerCase().replaceAll(/[-_]/g, '');
const FILE_ROUTE_KEYS = new Set(FILE_ROUTES.map(routeKey));

/** Every `[dotted path, value]` set below `value`, objects only (an array is a value). */
function settings(value, prefix = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return prefix.length > 0 ? [[prefix, value]] : [];
  const found = prefix.length > 0 ? [[prefix, value]] : [];
  for (const [key, child] of Object.entries(value)) found.push(...settings(child, [...prefix, key]));
  return found;
}

/** An icon the app may bundle or embed: one of its own images under `icons/`. */
const ICON = /^icons\/[\w@.-]+\.(?:png|icns|ico)$/;

/** What tauri.conf.json, and the folder it is in, route into the bundle beyond the app's own files. */
function configProblems(app, config) {
  const problems = [];
  for (const [path, value] of settings(config)) {
    const key = routeKey(path.join('.'));
    if (FILE_ROUTE_KEYS.has(key) && value !== undefined && value !== null && value !== false)
      problems.push(
        `tauri.conf.json: ${path.join('.')} is set; it routes a file into the bundle, which holds only the app's own`,
      );
    // A fixed WebView2 runtime is copied from a folder the configuration names; the other modes take the system's.
    if (key === 'bundle.windows.webviewinstallmode' && routeKey(String(value?.type ?? '')) === 'fixedruntime')
      problems.push(`tauri.conf.json: ${path.join('.')} is a fixed runtime; it routes a folder into the bundle`);
    if (key === 'app.trayicon.iconpath' && (typeof value !== 'string' || !ICON.test(value)))
      problems.push(`tauri.conf.json: ${path.join('.')} is not one of the app's icons under icons/`);
  }
  for (const icon of Array.isArray(config.bundle?.icon) ? config.bundle.icon : [])
    if (typeof icon !== 'string' || !ICON.test(icon))
      problems.push(
        `tauri.conf.json: bundle.icon names ${JSON.stringify(icon)}, not one of the app's icons under icons/`,
      );
  const build = config.build ?? {};
  if (build.frontendDist !== '../dist')
    problems.push('tauri.conf.json: build.frontendDist is not ../dist, the folder this check reads');
  if (build.beforeBuildCommand !== 'pnpm build')
    problems.push('tauri.conf.json: build.beforeBuildCommand is not pnpm build, so the bundle may differ from dist/');
  if (build.beforeBundleCommand !== undefined)
    problems.push('tauri.conf.json: build.beforeBundleCommand is set; nothing may change the app after this check');
  // Tauri merges a platform's own configuration file (and reads Tauri.toml or JSON5) beside tauri.conf.json.
  for (const entry of readdirSync(join(app, 'src-tauri')))
    if (entry !== 'tauri.conf.json' && /^tauri(?:\.[a-z0-9]+)?\.(?:conf\.json5?|toml)$/i.test(entry))
      problems.push(`src-tauri/${entry}: a second Tauri configuration; the app keeps one, tauri.conf.json`);
  return problems;
}

/** ONNX Runtime's Rust crates: `ort`, its `-sys` and other halves, and the older `onnxruntime` bindings. */
const LAYA_CRATES = /^(?:ort|onnxruntime)(?:[-_].*)?$/i;

/** The crates the Cargo manifest depends on, in every dependency table, renamed ones by their `package`. */
function cargoDependencies(manifest) {
  const names = [];
  let table = false;
  for (const line of manifest.split(/\r?\n/)) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
    if (header !== null) {
      const parts = /^(?:.+\.)?(?:dev-|build-)?dependencies(?:\.(.+))?$/.exec(header[1].trim());
      table = parts !== null;
      if (parts?.[1] !== undefined) names.push(parts[1].replaceAll('"', '').trim());
      continue;
    }
    if (!table) continue;
    const entry = /^\s*("?)([\w-]+)\1\s*=/.exec(line);
    if (entry !== null) names.push(entry[2]);
    for (const renamed of line.matchAll(/\bpackage\s*=\s*"([^"]+)"/g)) names.push(renamed[1]);
  }
  return names;
}

/** Each `include_bytes!`/`include_str!` in `source`, with the string literals its argument holds. */
function embeds(source) {
  const found = [];
  for (const match of source.matchAll(/\binclude_(?:bytes|str)!\s*([([{])/g)) {
    const open = match[1];
    const close = { '(': ')', '[': ']', '{': '}' }[open];
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < source.length; end += 1) {
      if (source[end] === open) depth += 1;
      else if (source[end] === close && --depth === 0) break;
    }
    const argument = source.slice(match.index + match[0].length, end);
    found.push([...argument.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((literal) => literal[1]));
  }
  return found;
}

/** Every `.rs` file of the app's crate the build compiles: its library and binary sources and its build script. */
function rustSources(app) {
  const crate = join(app, 'src-tauri');
  return [...filesBelow(app, join(crate, 'src')).filter((path) => path.endsWith('.rs')), 'src-tauri/build.rs'].filter(
    (path) => existsSync(join(app, path)),
  );
}

/** What the app's crate may not hold: an ONNX Runtime crate, or a model-like file its code embeds. */
function crateProblems(app) {
  const problems = [];
  const manifest = join(app, 'src-tauri', 'Cargo.toml');
  if (!existsSync(manifest)) return ['src-tauri/Cargo.toml is missing'];
  for (const name of cargoDependencies(readFileSync(manifest, 'utf8')))
    if (LAYA_CRATES.test(name))
      problems.push(`src-tauri/Cargo.toml: depends on ${name}; the app links nothing of ONNX Runtime`);
  const lock = join(app, 'src-tauri', 'Cargo.lock');
  if (existsSync(lock))
    for (const [, name] of readFileSync(lock, 'utf8').matchAll(/^name = "([^"]+)"$/gm))
      if (LAYA_CRATES.test(name))
        problems.push(`src-tauri/Cargo.lock: resolves ${name}; the app links nothing of ONNX Runtime`);
  for (const path of rustSources(app)) {
    for (const literals of embeds(readFileSync(join(app, path), 'utf8'))) {
      const named = literals.map((literal) => [literal, layaFile(literal)]).find(([, file]) => file !== undefined);
      if (named !== undefined)
        problems.push(`${path}: embeds ${named[0]}, ${named[1][1]}, for Laya; the app never holds one`);
    }
  }
  return problems;
}

/** What the app may never depend on: the Laya runtime's workspace, the events daemon, and the runtime's packages. */
const LAYA_PACKAGES = [
  /^@agentcomms\/events-laya-runtime$/,
  /^@agentcomms\/events-daemon$/,
  /^@receptron\/laya$/,
  /^onnxruntime(?:-|$)/,
  /^@huggingface\/tokenizers$/,
];
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundleDependencies',
  'bundledDependencies',
];

/** Every file below `directory`, links included, as paths relative to `root` with `/`; no file is opened. */
function filesBelow(root, directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true })
    .map((entry) => join(directory, String(entry)))
    .filter((path) => !lstatSync(path).isDirectory())
    .map((path) => relative(root, path).split(sep).join('/'))
    .sort();
}

/** The names `field` of a package manifest lists, whether it is a map of versions or a list. */
function dependencyNames(value) {
  if (Array.isArray(value)) return value.filter((name) => typeof name === 'string');
  if (value !== null && typeof value === 'object') return Object.keys(value);
  return [];
}

/** Everything the built app at `app` (its `dist/`, `package.json` and `src-tauri/tauri.conf.json`) may not hold. */
export function bundleProblems({ app = APP } = {}) {
  const dist = join(app, 'dist');
  const problems = [];

  const config = JSON.parse(readFileSync(join(app, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const bundle = config.bundle ?? {};
  if (bundle.externalBin !== undefined)
    problems.push('tauri.conf.json: bundle.externalBin is set; the app bundles no binary');
  if (bundle.resources !== undefined)
    problems.push('tauri.conf.json: bundle.resources is set; the app bundles no resources');
  problems.push(...configProblems(app, config));
  problems.push(...crateProblems(app));

  const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of dependencyNames(manifest[field])) {
      if (LAYA_PACKAGES.some((pattern) => pattern.test(name)))
        problems.push(
          `package.json: ${field} names ${name}; the app depends on nothing of Laya's or the events daemon's`,
        );
    }
  }

  if (!existsSync(join(dist, 'index.html'))) {
    problems.push('dist/index.html is missing: run the build first');
    return problems;
  }
  for (const entry of readdirSync(dist)) {
    if (entry !== 'index.html' && entry !== 'assets') problems.push(`dist/${entry} is neither index.html nor assets/`);
  }
  const assets = join(dist, 'assets');
  const files = existsSync(assets) ? readdirSync(assets) : [];
  for (const file of files) {
    if (lstatSync(join(assets, file)).isDirectory())
      problems.push(`dist/assets/${file} is a folder: assets/ holds files`);
  }

  const unread = new Set();
  for (const path of filesBelow(app, dist)) {
    const file = layaFile(path);
    if (file !== undefined) problems.push(`${path}: ${file[1]}, for Laya; the app never holds one`);
    const info = lstatSync(join(app, path));
    if (!info.isFile()) {
      problems.push(`${path} is a link or a special file; dist/ holds only files the build wrote`);
      unread.add(path);
      continue;
    }
    if (info.size > BUILT_FILE_LIMIT_BYTES) {
      problems.push(`${path} is ${info.size} bytes, over the ${BUILT_FILE_LIMIT_BYTES}-byte limit; refused unread`);
      unread.add(path);
      continue;
    }
    const text = readFileSync(join(app, path)).toString('latin1');
    const names = LAYA_TEXT.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
    if (names.length > 0)
      problems.push(`${path} names ${names.join(', ')}: nothing of Laya's runtime or worker is the app's`);
  }

  if (unread.has('dist/index.html')) return problems;
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(
    ([, attributes]) => !/\bsrc=/.test(attributes),
  );
  if (inline.length !== 1) {
    problems.push(`dist/index.html has ${inline.length} inline scripts; exactly one, the pre-paint script, is allowed`);
  } else {
    const hash = createHash('sha256').update(inline[0][2], 'utf8').digest('base64');
    const scriptSources = /(?:^|;)\s*script-src\s+([^;]*)/.exec(config.app?.security?.csp ?? '')?.[1] ?? '';
    if (!scriptSources.split(/\s+/).includes(`'sha256-${hash}'`)) {
      problems.push(`the inline script's hash, sha256-${hash}, is not in the content policy's script-src`);
    }
  }

  const texts = [
    ['dist/index.html', html],
    ...files
      .filter((file) => file.endsWith('.css') && !unread.has(`dist/assets/${file}`))
      .map((file) => [`dist/assets/${file}`, readFileSync(join(assets, file), 'utf8')]),
  ];
  for (const [name, text] of texts) {
    const uncommented = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
    const withoutNamespaces = uncommented.replace(/url\(\s*(["']?)data:[^)]*\)/g, (uri) =>
      uri.replace(/xmlns(?::\w+)?(?:=|%3D)(?:%27|%22|['"])https?:\/\/www\.w3\.org\/[\w/.-]+/gi, 'xmlns=namespace'),
    );
    for (const match of withoutNamespaces.matchAll(/https?:\/\/[^\s"'<>)]{0,80}/g)) {
      problems.push(`${name} names a remote address: ${match[0]}`);
    }
  }
  return problems;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = bundleProblems();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  process.stdout.write('desktop bundle check: OK\n');
}
