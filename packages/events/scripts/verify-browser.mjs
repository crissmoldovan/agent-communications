#!/usr/bin/env node
/**
 * The event library's vectors in real Chromium and WebKit (events phase A plan, decision 3, layer 4).
 *
 *   pnpm verify:browser      # from the repository root; it is not part of `pnpm verify`
 *
 * WebKit is JavaScriptCore, the engine of the macOS webview (WKWebView) the desktop app uses, and of WebKitGTK;
 * Chromium is the engine of Windows' WebView2. The bare realm every `pnpm verify` runs (`test/support/realm.ts`) has no
 * host at all, which a browser never is, but it cannot see a difference between JavaScript engines. This can.
 *
 * It builds the same browser-platform IIFE bundle the realm runs, serves it from a loopback listener on 127.0.0.1 — a
 * secure context, so `crypto.subtle` is there, as in the app's own origin — under the desktop app's exact production
 * CSP (design 2026-10-05, D13), and opens the page in Chromium, then in WebKit. For every vector family it calls
 * `AgentcommsEventsRealm.run` in the page and requires no failures and result JSON byte-identical to the same family's
 * Node and realm results, computed here, in this process. It also requires that the page made no request but itself,
 * its `boot.js` and the bundle, and that the CSP held: the page's own `boot.js` tries `new Function('')` and records
 * what happened, because Playwright's `evaluate` is not the page's script and is not held to the page's CSP.
 *
 * Without the browsers it stops, before launching anything, and says how to install them once.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const at = (...parts) => join(PACKAGE_ROOT, ...parts);
const say = (line) => process.stdout.write(`${line}\n`);

/** Every phase-A vector family, deliberately listed so a later one cannot silently skip either browser. */
export const VECTOR_FAMILIES = [
  'canonical-json',
  'event-id',
  'unicode',
  'idna',
  'formats',
  'pointers',
  'catalogue',
  'resend-body',
  'conditions',
  'mapping',
  'envelopes',
];

/** The two derived conformance files Phase A's final audit owns; CaseFolding.txt still runs as the unicode family. */
export const REQUIRED_CONFORMANCE_FILES = ['NormalizationTest.txt', 'IdnaTestV2.txt'];

function sameNames(actual, expected, what) {
  const found = [...actual].sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(found) !== JSON.stringify(wanted)) {
    throw new Error(`${what}: expected ${wanted.join(', ')}, found ${found.join(', ')}`);
  }
}

/** D13's production `security.csp`, exactly (spec line 2631). */
export const PRODUCTION_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

/** How long one browser step may take: a launch, a page load, one family's vectors. A step that hangs fails. */
const STEP_MS = 120_000;

/** `promise`, or a failure naming `what` once `STEP_MS` has passed. */
function bounded(promise, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${STEP_MS / 1000} s`)), STEP_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const BROWSERS = [
  ['chromium', chromium],
  ['webkit', webkit],
];

// The browsers first: without them nothing else is worth starting, and nothing is downloaded here.
const missing = BROWSERS.filter(([, type]) => !existsSync(type.executablePath())).map(([name]) => name);
if (missing.length > 0) {
  process.stderr.write(
    [
      `The event library's browser run needs Playwright's Chromium and WebKit, and ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not installed here.`,
      'Install them once, from the repository root:',
      '',
      '  pnpm --filter @agentcomms/events exec playwright install chromium webkit',
      '',
      'On Linux add --with-deps, which installs the system libraries they need. Then run pnpm verify:browser again.',
      'pnpm verify does not run this, so it needs nothing of the browsers.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const library = await import(new URL('../src/index.ts', import.meta.url).href);
const { RUNNERS } = await import(new URL('../test/realm/runners/index.ts', import.meta.url).href);
const { createRealm, realmBundle } = await import(new URL('../test/support/realm.ts', import.meta.url).href);

sameNames(Object.keys(RUNNERS), VECTOR_FAMILIES, 'BRW-a: test/realm/runners/index.ts names the phase-A families');

const bundle = await realmBundle();
const realm = createRealm(bundle);

/**
 * Every vector family, and every Unicode conformance file derived from its pinned source: the text the page is given,
 * and its results in Node and in the realm, which must agree. `label` is what a line of output calls it.
 */
const families = [];
async function addFamily(name, text, label) {
  const file = JSON.parse(text);
  const runner = RUNNERS[file.family];
  if (runner === undefined) throw new Error(`${name}: no runner for the family "${file.family}"`);
  const inNode = JSON.stringify(await runner(library, file));
  const inRealm = await realm.run(file.family, text);
  if (inRealm !== inNode) throw new Error(`${label}: the realm's results differ from Node's`);
  if (JSON.parse(inNode).failures.length > 0) throw new Error(`${label}: fails in Node`);
  families.push({ name, family: file.family, label, text, expected: inNode, vectors: file.vectors.length });
}
const vectorFiles = readdirSync(at('test', 'vectors'))
  .filter((file) => file.endsWith('.json'))
  .sort();
const vectorFamilies = [];
for (const name of vectorFiles) {
  const text = readFileSync(at('test', 'vectors', name), 'utf8');
  const file = JSON.parse(text);
  vectorFamilies.push(file.family);
  await addFamily(`test/vectors/${name}`, text, file.family);
}
sameNames(vectorFamilies, VECTOR_FAMILIES, 'test/vectors names exactly the eleven phase-A families');
// Unicode's own conformance files — NormalizationTest.txt, CaseFolding.txt and IdnaTestV2.txt — derived from their
// pinned sources exactly as the package's tests derive them (test/support/conformance-sources.ts).
const { conformanceFiles } = await import(new URL('../test/support/conformance-sources.ts', import.meta.url).href);
const derivedFiles = conformanceFiles();
sameNames(
  derivedFiles.filter((derived) => REQUIRED_CONFORMANCE_FILES.includes(derived.name)).map((derived) => derived.name),
  REQUIRED_CONFORMANCE_FILES,
  'BRW-d: the final browser audit has both required Unicode conformance files',
);
for (const derived of derivedFiles) {
  if (!VECTOR_FAMILIES.includes(derived.family)) {
    throw new Error(`${derived.name}: its ${derived.family} family is not in the phase-A browser audit`);
  }
  await addFamily(derived.name, derived.text, `${derived.family} (${derived.name})`);
}

// The page, its boot script and the bundle, and nothing else, from a loopback listener.
const pages = {
  '/': { type: 'text/html; charset=utf-8', body: readFileSync(at('test', 'browser', 'index.html'), 'utf8') },
  '/boot.js': { type: 'text/javascript; charset=utf-8', body: readFileSync(at('test', 'browser', 'boot.js'), 'utf8') },
  '/realm.js': { type: 'text/javascript; charset=utf-8', body: bundle },
};
const served = [];
const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  served.push(path);
  const page = pages[path];
  if (page === undefined) {
    response.writeHead(404, { 'Content-Security-Policy': PRODUCTION_CSP }).end();
    return;
  }
  response.writeHead(200, {
    'Content-Type': page.type,
    'Content-Security-Policy': PRODUCTION_CSP,
    'Cache-Control': 'no-store',
  });
  response.end(page.body);
});
await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
const origin = `http://127.0.0.1:${server.address().port}`;

const problems = [];
try {
  for (const [name, type] of BROWSERS) {
    let browser;
    try {
      browser = await bounded(type.launch({ headless: true }), `launching ${name}`);
      const page = await bounded(browser.newPage(), `opening a page in ${name}`);
      const requests = [];
      page.on('request', (request) => requests.push(request.url()));
      await bounded(page.goto(`${origin}/`), `loading the page in ${name}`);
      await page.waitForFunction(() => globalThis.agentcommsBoot !== undefined, undefined, { timeout: STEP_MS });
      const boot = await bounded(
        page.evaluate(() => globalThis.agentcommsBoot),
        `reading the boot script's record in ${name}`,
      );
      if (boot.loaded !== true) problems.push(`${name}: the bundle did not load in the page`);
      if (boot.secureContext !== true) problems.push(`${name}: the page is not a secure context`);
      if (boot.evalRefused !== true) {
        problems.push(`${name}: the CSP did not hold — new Function('') in the page gave ${boot.evalOutcome}`);
      }
      for (const family of families) {
        const result = await bounded(
          page.evaluate(
            ([family, text]) => globalThis.AgentcommsEventsRealm.run(family, text),
            [family.family, family.text],
          ),
          `${family.label} in ${name}`,
        );
        const failures = JSON.parse(result).failures;
        if (failures.length > 0) {
          problems.push(`${family.label} in ${name}: ${failures.length} failing: ${failures.slice(0, 3).join('; ')}`);
        } else if (result !== family.expected) {
          problems.push(`${family.label} in ${name}: the results differ from Node's and the realm's`);
        } else {
          say(
            `  ✓ ${family.label} in ${name}: ${family.vectors} ${family.vectors === 1 ? 'vector' : 'vectors'}, identical to Node and the realm`,
          );
        }
      }
      const wanted = ['/', '/boot.js', '/realm.js'].map((path) => `${origin}${path}`);
      const extra = requests.filter((url) => !wanted.includes(url));
      if (extra.length > 0 || requests.length !== wanted.length) {
        problems.push(`${name}: the page requested ${requests.join(', ')}; only ${wanted.join(', ')} are its`);
      }
    } catch (error) {
      problems.push(`${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    } finally {
      if (browser !== undefined) await bounded(browser.close(), `closing ${name}`).catch(() => undefined);
    }
  }
} finally {
  await new Promise((closed) => server.close(closed));
}
const unexpected = served.filter((path) => !['/', '/boot.js', '/realm.js'].includes(path));
if (unexpected.length > 0) problems.push(`the listener was asked for ${unexpected.join(', ')}`);

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`  ✗ ${problem}\n`);
  process.exit(1);
}
const derived = families.filter((family) => !family.name.startsWith('test/vectors/')).length;
say(
  `BRW-a and BRW-d: event vectors in real browsers OK: ${families.length - derived} vector ${families.length - derived === 1 ? 'file' : 'files'} and ${derived} Unicode conformance ${derived === 1 ? 'file' : 'files'} in chromium and webkit, under the production CSP`,
);
