import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The one rule the whole project rests on: **mail leaves this machine from exactly one place.**
 *
 * Every Gmail permission that allows drafting also allows sending, so "an agent may draft but not send" cannot be
 * enforced by the grant. It is enforced by there being a single code path to Gmail's send endpoints, which runs the
 * approval checks. A second caller — added in good faith, in a hurry, by anyone — would not fail any other test, so
 * this one exists to fail instead.
 *
 * It is here from the phase before sending is implemented, so it is never "added later".
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Where a call to a Gmail send endpoint is allowed to appear. Nothing else may name one. */
const ALLOWED = [
  join('packages', 'gmail', 'src', 'operations', 'send.ts'),
  // The test that proves the gate refuses, and this file, which names the endpoints to look for them.
  join('packages', 'gmail', 'test', 'send-gate.test.ts'),
  join('test', 'send-path.test.mjs'),
];

/** Gmail's ways of transmitting a message. `drafts.create` and `drafts.update` are not among them. */
const SEND_CALLS = [/drafts\s*\.\s*send/, /messages\s*\.\s*send/, /\/messages\/send/, /\/drafts\/send/];

/** Comments are stripped before matching: writing *about* the rule (as this project does often) is not breaking it. */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'coverage', '.blocks']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs', '.cjs']);

async function sourceFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.blocks') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      found.push(...(await sourceFiles(path)));
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
      found.push(path);
    }
  }
  return found;
}

test('only the send operation may call a Gmail send endpoint', async () => {
  const offenders = [];
  for (const file of await sourceFiles(ROOT)) {
    const path = relative(ROOT, file);
    if (ALLOWED.includes(path)) continue;
    const source = withoutComments(await readFile(file, 'utf8'));
    for (const pattern of SEND_CALLS) {
      if (!pattern.test(source)) continue;
      const line = source.split('\n').findIndex((text) => pattern.test(text)) + 1;
      offenders.push(`${path.split(sep).join('/')}:${line} matches ${pattern}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `mail may only be transmitted from ${ALLOWED[0]}; found another caller:\n${offenders.join('\n')}`,
  );
});

test('the transport this package exposes has no send method at all', async () => {
  const transport = await readFile(join(ROOT, 'packages', 'gmail', 'src', 'gmail-api', 'transport.ts'), 'utf8');
  const interfaceBody = /export interface GmailTransport \{([\s\S]*?)\n\}/.exec(transport)?.[1] ?? '';
  assert.notEqual(interfaceBody, '', 'the GmailTransport interface should be readable');
  const members = [...withoutComments(interfaceBody).matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)/gm)].map(
    (match) => match[1],
  );
  // `listSendAs` reads the addresses an account may send as, which is not a way to transmit anything.
  const senders = members.filter((name) => /^send/i.test(name));
  assert.deepEqual(senders, [], 'a send method on the shared transport would be reachable by anything that has it');
});
