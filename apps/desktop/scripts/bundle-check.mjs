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
 *
 * Prints `desktop bundle check: OK`, or every problem and exits 1.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(APP, 'dist');
const problems = [];

const config = JSON.parse(readFileSync(join(APP, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const bundle = config.bundle ?? {};
if (bundle.externalBin !== undefined)
  problems.push('tauri.conf.json: bundle.externalBin is set; the app bundles no binary');
if (bundle.resources !== undefined)
  problems.push('tauri.conf.json: bundle.resources is set; the app bundles no resources');

if (!existsSync(join(DIST, 'index.html'))) {
  problems.push('dist/index.html is missing: run the build first');
} else {
  for (const entry of readdirSync(DIST)) {
    if (entry !== 'index.html' && entry !== 'assets') problems.push(`dist/${entry} is neither index.html nor assets/`);
  }
  const assets = join(DIST, 'assets');
  const files = existsSync(assets) ? readdirSync(assets) : [];
  for (const file of files) {
    if (!statSync(join(assets, file)).isFile()) problems.push(`dist/assets/${file} is a folder: assets/ holds files`);
  }

  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
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
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
process.stdout.write('desktop bundle check: OK\n');
