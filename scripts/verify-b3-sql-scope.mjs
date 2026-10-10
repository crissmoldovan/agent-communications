#!/usr/bin/env node
/** B3 raw/external identity writes must visibly carry account and source scope, and use imported source vocabulary. */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function sourceFiles(root, directory = join(root, 'packages/events-daemon/src')) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? sourceFiles(root, join(directory, entry.name))
          : entry.name.endsWith('.ts')
            ? [relative(root, join(directory, entry.name))]
            : [],
      ),
    )
  ).flat();
}

export async function verifyB3SqlScope({ root = ROOT, files = undefined } = {}) {
  const problems = [];
  for (const file of files ?? (await sourceFiles(root))) {
    const text = await readFile(join(root, file), 'utf8');
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!/\b(?:UPDATE|DELETE\s+FROM)\b/i.test(line) || !/(?:raw_|external_|message_id|occurrence_key)/i.test(line))
        continue;
      const nearby = lines.slice(Math.max(0, index - 2), index + 3).join('\n');
      if (!/B3_SQL_SCOPE:\s*[^\n]*\baccount\b[^\n]*\bsource\b/i.test(nearby))
        problems.push(`${file}: raw/external identity SQL needs a B3_SQL_SCOPE annotation naming account and source`);
    }
    if (/\b(?:const|let|var)\s+(?:WHATSAPP|GMAIL|SLACK|RESEND)_[A-Z_]+\s*=/.test(text))
      problems.push(`${file}: B3 code must import channel vocabulary instead of copying it`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = await verifyB3SqlScope();
  if (problems.length) {
    console.error(problems.map((problem) => `- ${problem}`).join('\n'));
    process.exitCode = 1;
  }
}
