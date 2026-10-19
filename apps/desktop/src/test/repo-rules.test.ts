// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INSTALL_COMMAND } from '../install.ts';

/*
 * The app's own guards. The repository's printed-command guard (`test/printed-command-construction.test.mjs`) reads
 * only `packages/<name>/src`, so nothing there sees this app: these rules are its half. This file names what it
 * forbids, so it is the one source each scan below leaves out.
 */

const APP = fileURLToPath(new URL('../../', import.meta.url));
const ROOT = join(APP, '..', '..');
const SELF = join('src', 'test', 'repo-rules.test.ts');

/** Every file under `directory` (relative to the app), as `{ path, text }`, `path` with `/`, skipping build output. */
function filesUnder(directory: string, keep: (path: string) => boolean): { path: string; text: string }[] {
  const absolute = join(APP, directory);
  if (!existsSync(absolute)) return [];
  const skipped = ['node_modules', 'target', 'gen', 'dist', 'test-results', 'playwright-report'];
  const files: { path: string; text: string }[] = [];
  for (const entry of readdirSync(absolute, { recursive: true })) {
    const relative = join(directory, String(entry));
    if (relative.split(sep).some((part) => skipped.includes(part))) continue;
    if (relative === SELF || !statSync(join(APP, relative)).isFile() || !keep(relative)) continue;
    files.push({ path: relative.split(sep).join('/'), text: readFileSync(join(APP, relative), 'utf8') });
  }
  return files;
}

/** The app's runtime sources: its TypeScript and its Rust. */
function runtimeSources(): { path: string; text: string }[] {
  return [
    ...filesUnder('src', (path) => /\.(?:ts|tsx)$/.test(path)),
    ...filesUnder(join('src-tauri', 'src'), (path) => path.endsWith('.rs')),
  ];
}

const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

/** What the repository's guard derives the suite's binaries from: every package's manifest. Never listed here. */
async function suiteBinaries(): Promise<string[]> {
  const guard = pathToFileURL(join(ROOT, 'test', 'helpers', 'printed-command-guard.mjs')).href;
  const { suiteFacts } = (await import(guard)) as { suiteFacts: (root: string) => { binaries: string[] } };
  return suiteFacts(ROOT).binaries;
}

describe("the app's repository rules", () => {
  it('no runtime string names a suite binary as a command', async () => {
    const binaries = await suiteBinaries();
    expect(binaries.length).toBeGreaterThan(0);
    // A binary's name as a word of its own, followed by whitespace: the start of a command a person could copy.
    const command = new RegExp(`(?<![\\w-])(?:${binaries.map(escapeRegExp).join('|')})(?:\\.(?:cmd|exe))?\\s`, 'i');
    const runner = /\bnpx\b[^\n]*@agentcomms\//;
    const findings: string[] = [];
    for (const { path, text } of runtimeSources()) {
      text.split('\n').forEach((line, index) => {
        // The one exemption: the documented install command, which is pinned to the README below.
        if (path === 'src/install.ts' && line.includes(JSON.stringify(INSTALL_COMMAND).slice(1, -1))) return;
        if (command.test(line) || runner.test(line)) findings.push(`${path}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(findings).toEqual([]);
  });

  it("the install command is the README's", () => {
    const line = readFileSync(join(ROOT, 'README.md'), 'utf8').split('\n')[99] ?? '';
    expect(line.split('#')[0]?.trim()).toBe(INSTALL_COMMAND);
  });

  it('no source renders HTML or Markdown', () => {
    const forbidden = [/dangerouslySetInnerHTML/, /\binnerHTML\b/, /\bouterHTML\b/, /@cueplusplus\/ui\/elements/];
    const findings = runtimeSources().flatMap(({ path, text }) =>
      forbidden.filter((pattern) => pattern.test(text)).map((pattern) => `${path}: ${pattern}`),
    );
    expect(findings).toEqual([]);
  });

  it('no source reaches the network', () => {
    const forbidden = [/\bfetch\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/];
    const findings = runtimeSources()
      .filter(({ path }) => !path.startsWith('src/test/'))
      .flatMap(({ path, text }) =>
        forbidden.filter((pattern) => pattern.test(text)).map((pattern) => `${path}: ${pattern}`),
      );
    expect(findings).toEqual([]);
  });

  it('no @tauri-apps/plugin- package is a dependency', () => {
    const manifest = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));
    const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(dependencies.filter((name) => name.startsWith('@tauri-apps/plugin-'))).toEqual([]);
  });

  it('no file names a real home', () => {
    const binary = /\.(?:png|icns|ico|jpg|jpeg|gif|webp|woff2?)$/;
    const realHome = homedir();
    // Each at the start of a path, so a folder named home inside an example path is not read as a home.
    const homes = [
      /(?<![\w.~/-])\/Users\/(?!example\b)[A-Za-z0-9._-]+/,
      /(?<![\w.~/-])\/home\/(?!example\b)[A-Za-z0-9._-]+/,
      /(?<![\w.~/-])[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)(?!example\b)[A-Za-z0-9._-]+/i,
    ];
    const findings: string[] = [];
    for (const { path, text } of filesUnder('.', (path) => !binary.test(path))) {
      if (text.includes(realHome)) findings.push(`${path}: names this machine's home`);
      for (const pattern of homes) {
        const match = pattern.exec(text);
        if (match) findings.push(`${path}: ${match[0]}`);
      }
    }
    expect(findings).toEqual([]);
  });
});
