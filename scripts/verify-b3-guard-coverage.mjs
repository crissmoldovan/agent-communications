#!/usr/bin/env node
/** Validates the append-only B3 mutation ledger before a task can claim its safety guards. */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = Object.freeze([
  'case',
  'operation',
  'productionEntry',
  'test',
  'mutation',
  'mutationTest',
  'loadedMarker',
]);

export async function readB3GuardManifests(root = ROOT) {
  const directory = join(root, 'packages/events-daemon/test/b3-guard-manifests');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort();
  return Promise.all(files.map(async (file) => JSON.parse(await readFile(join(directory, file), 'utf8'))));
}

export async function verifyB3GuardCoverage({ root = ROOT, manifests = undefined } = {}) {
  const problems = [];
  const seen = new Set();
  const loaded = manifests ?? (await readB3GuardManifests(root));
  for (const manifest of loaded) {
    const area = typeof manifest?.area === 'string' && manifest.area ? manifest.area : '<unknown-area>';
    if (!Array.isArray(manifest?.cases) || manifest.cases.length === 0) {
      problems.push(`${area}: missing non-empty "cases"`);
      continue;
    }
    for (const entry of manifest.cases) {
      const label = `${area}/${typeof entry?.case === 'string' ? entry.case : '<unknown-case>'}`;
      if (seen.has(entry?.case)) problems.push(`${label}: case is named by more than one manifest`);
      else if (typeof entry?.case === 'string') seen.add(entry.case);
      for (const field of REQUIRED) {
        const value = entry?.[field];
        const present =
          field === 'mutation'
            ? value !== undefined && value !== null && value !== ''
            : typeof value === 'string' && value.length > 0;
        if (!present) problems.push(`${label}: missing non-empty "${field}"`);
      }
      if (typeof entry?.productionEntry === 'string') {
        if (/(?:^|\/)test(?:\/|$)/.test(entry.productionEntry)) {
          problems.push(
            `${label}: production entry must be runtime source, not test support: ${entry.productionEntry}`,
          );
        } else {
          const source = await readFile(join(root, entry.productionEntry), 'utf8').catch(() => undefined);
          if (source === undefined)
            problems.push(`${label}: production entry does not exist: ${entry.productionEntry}`);
        }
      }
      if (typeof entry?.test === 'string') {
        const text = await readFile(join(root, entry.test), 'utf8').catch(() => undefined);
        if (text === undefined) problems.push(`${label}: named production-path test does not exist: ${entry.test}`);
        else if (typeof entry?.mutationTest === 'string' && !text.includes(entry.mutationTest))
          problems.push(`${label}: mutationTest is not a named case in ${entry.test}`);
      }
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = await verifyB3GuardCoverage();
  if (problems.length) {
    console.error(problems.map((problem) => `- ${problem}`).join('\n'));
    process.exitCode = 1;
  }
}
