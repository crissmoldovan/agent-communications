#!/usr/bin/env node
/**
 * One version, everywhere it is written down.
 *
 * A released version appears in more places than anybody remembers: three package manifests, a plugin manifest, a
 * Gemini extension, a launcher script with a pinned `npx` target, and a `compatibility` line in each of twelve
 * skills. Every one of those is a place a user copies a command from, and a stale one sends them to a version that
 * does not exist or, worse, an older one that still does. So the root `package.json` version is the source and this
 * writes it into the rest.
 *
 * `--check` verifies without writing, which is what CI runs.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const check = process.argv.includes('--check');
const problems = [];

async function put(path, content, what) {
  const current = await readFile(path, 'utf8').catch(() => null);
  if (current === content) return;
  if (check) {
    problems.push(`${path.replace(ROOT, '')}: ${what} is out of date — run \`pnpm sync:versions\``);
    return;
  }
  await writeFile(path, content);
}

const root = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const version = root.version;
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`the root package.json version is "${version}", which is not a version`);
  process.exit(1);
}

// The published packages, in lockstep. They depend on each other by exact version, so a mismatch is a broken install.
const packages = ['core', 'gmail', 'gmail-mcp'];
for (const name of packages) {
  const path = join(ROOT, 'packages', name, 'package.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.version = version;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
      // Workspace ranges stay as they are: pnpm rewrites them at pack time.
      if (dependency.startsWith('@agentcomms/') && !String(range).startsWith('workspace:')) {
        manifest[field][dependency] = version;
      }
    }
  }
  await put(path, `${JSON.stringify(manifest, null, 2)}\n`, 'version');
}

// Each skill states which package version it was written against, so a user installing both can see a mismatch.
const skills = join(ROOT, 'skills');
for (const entry of await readdir(skills, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith('gmail-')) continue;
  const path = join(skills, entry.name, 'SKILL.md');
  const source = await readFile(path, 'utf8');
  const updated = source.replace(
    /^compatibility: "@agentcomms\/gmail@[^"]+"$/m,
    `compatibility: "@agentcomms/gmail@${version}"`,
  );
  if (!/^compatibility: /m.test(source)) {
    problems.push(`skills/${entry.name}/SKILL.md: no compatibility line to keep in step`);
    continue;
  }
  await put(path, updated, 'the compatibility line');
}

/**
 * The plugin manifest and the Gemini extension both pin the version they launch.
 *
 * Edited as text rather than parsed and re-serialised: the formatter keeps a short array on one line and
 * `JSON.stringify` expands it, so a round trip through the parser reformats the file and the two fight each other
 * for ever — with `--check` failing on a file nobody changed.
 */
for (const [path, what] of [
  [join(ROOT, '.claude-plugin', 'marketplace.json'), 'the plugin version'],
  [join(ROOT, 'gemini-extension.json'), 'the extension version'],
]) {
  const source = await readFile(path, 'utf8').catch(() => null);
  if (source === null) continue;
  await put(
    path,
    source
      .replace(/"version":\s*"[\w.-]+"/g, `"version": "${version}"`)
      .replace(/@agentcomms\/gmail-mcp@[\w.-]+/g, `@agentcomms/gmail-mcp@${version}`),
    what,
  );
}

const launcher = join(ROOT, 'bin', 'agent-gmail-launch');
const script = await readFile(launcher, 'utf8').catch(() => null);
if (script !== null) {
  await put(
    launcher,
    script
      .replace(/^VERSION="[\w.-]+"$/m, `VERSION="${version}"`)
      .replace(/@agentcomms\/gmail-mcp@[\w.-]+/g, `@agentcomms/gmail-mcp@${version}`),
    'the pinned launcher version',
  );
  if (!/^VERSION="/m.test(script)) {
    problems.push('bin/agent-gmail-launch: no VERSION line to keep in step');
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(`versions in step at ${version}.`);
