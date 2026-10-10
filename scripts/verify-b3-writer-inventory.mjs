#!/usr/bin/env node
/** The writer inventory is a fail-closed manifest: every cipher/secret writer names its leased entrypoint. */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function filesBelow(root, directory = join(root, 'packages/events-daemon/src')) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? filesBelow(root, join(directory, entry.name))
          : entry.name.endsWith('.ts')
            ? [relative(root, join(directory, entry.name))]
            : [],
      ),
    )
  ).flat();
}

export async function verifyB3WriterInventory({ root = ROOT, inventory = [], files = undefined } = {}) {
  const listed = new Set(inventory.map((entry) => (typeof entry === 'string' ? entry : entry.entry)));
  const problems = [];
  for (const file of files ?? (await filesBelow(root))) {
    const text = await readFile(join(root, file), 'utf8');
    if (!/\b(?:cipher\.(?:encrypt|decrypt)|secret(?:Store|Backend)?\.(?:set|get|delete))\s*\(/.test(text)) continue;
    if (!listed.has(file))
      problems.push(`${file}: cipher/secret writer is absent from the explicit B3 lease inventory`);
    else if (!/withEventWriterLease\s*\(/.test(text))
      problems.push(`${file}: listed cipher/secret writer does not acquire withEventWriterLease`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = await verifyB3WriterInventory();
  if (problems.length) {
    console.error(problems.map((problem) => `- ${problem}`).join('\n'));
    process.exitCode = 1;
  }
}
