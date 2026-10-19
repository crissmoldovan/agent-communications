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
 *
 * Prints `desktop bundle check: OK`, or every problem and exits 1.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));

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

/** Every file below `directory`, as paths relative to `root` with `/`. */
function filesBelow(root, directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true })
    .map((entry) => join(directory, String(entry)))
    .filter((path) => statSync(path).isFile())
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
    if (!statSync(join(assets, file)).isFile()) problems.push(`dist/assets/${file} is a folder: assets/ holds files`);
  }

  for (const path of filesBelow(app, dist)) {
    const file = LAYA_FILES.find(([pattern]) => pattern.test(path));
    if (file !== undefined) problems.push(`${path}: ${file[1]}, for Laya; the app never holds one`);
    const text = readFileSync(join(app, path)).toString('latin1');
    const names = LAYA_TEXT.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
    if (names.length > 0)
      problems.push(`${path} names ${names.join(', ')}: nothing of Laya's runtime or worker is the app's`);
  }

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
      .filter((file) => file.endsWith('.css'))
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
