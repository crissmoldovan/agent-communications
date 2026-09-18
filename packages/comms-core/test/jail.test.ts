import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { CommsError } from '../src/errors.ts';
import { checkAttachable, createUniqueFile, isInside, resolveInsideRoot, safeFilename, slug } from '../src/jail.ts';
import { tempDir } from './helpers/temp.ts';

const posix = process.platform !== 'win32';
const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);

test('safeFilename strips separators, control and Windows-illegal characters', () => {
  assert.equal(safeFilename('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(safeFilename('a\\b/c.pdf'), 'a_b_c.pdf');
  assert.equal(safeFilename(`in${NUL}voice${BEL}.pdf`), 'in_voice_.pdf');
  assert.equal(safeFilename('what?:*|<>".txt'), 'what_______.txt');
  assert.equal(safeFilename('  ..hidden  '), 'hidden');
  assert.equal(safeFilename(''), 'attachment');
  assert.equal(safeFilename('...'), 'attachment');
});

test('safeFilename avoids Windows reserved device names', () => {
  assert.equal(safeFilename('CON'), '_CON');
  assert.equal(safeFilename('nul.txt'), '_nul.txt');
  assert.equal(safeFilename('com1.pdf'), '_com1.pdf');
  assert.equal(safeFilename('console.txt'), 'console.txt');
});

test('safeFilename normalises to NFC and caps UTF-8 bytes while keeping the extension', () => {
  assert.equal(safeFilename('cafe\u0301.pdf'), 'café.pdf');
  const result = safeFilename(`${'é'.repeat(300)}.pdf`);
  assert.ok(Buffer.byteLength(result, 'utf8') <= 255);
  assert.ok(result.endsWith('.pdf'));
  assert.ok(!result.includes('�'));
});

test('slug makes short directory-safe names', () => {
  assert.equal(slug('Re: Q3 Invoice - ACME Ltd.'), 're-q3-invoice-acme-ltd');
  assert.equal(slug('Überweisung für März'), 'uberweisung-fur-marz');
  assert.equal(slug('!!!'), 'untitled');
  assert.ok(slug('x'.repeat(100)).length <= 40);
});

test('isInside is lexical and rejects siblings with a shared prefix', () => {
  assert.ok(isInside('/a/b/c', '/a/b'));
  assert.ok(isInside('/a/b', '/a/b'));
  assert.ok(!isInside('/a/bc', '/a/b'));
  assert.ok(!isInside('/a', '/a/b'));
});

test('resolveInsideRoot refuses traversal and links that leave the root', async () => {
  const root = tempDir();
  const outside = tempDir();
  assert.equal(await resolveInsideRoot(root, 'x/y.pdf'), join(root, 'x', 'y.pdf'));
  await assert.rejects(resolveInsideRoot(root, '../escape.pdf'), CommsError);
  if (posix) {
    symlinkSync(outside, join(root, 'link'));
    await assert.rejects(resolveInsideRoot(root, 'link/file.pdf'), /link that leaves/);
  }
});

test('createUniqueFile never overwrites and never follows a final symlink', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'a.pdf'), 'existing');
  const first = await createUniqueFile(dir, 'a.pdf');
  await first.handle.writeFile('new');
  await first.handle.close();
  assert.equal(first.path, join(dir, 'a-2.pdf'));
  assert.equal(readFileSync(join(dir, 'a.pdf'), 'utf8'), 'existing');
  if (posix) {
    const target = join(tempDir(), 'victim.txt');
    writeFileSync(target, 'keep');
    symlinkSync(target, join(dir, 'b.pdf'));
    const second = await createUniqueFile(dir, 'b.pdf');
    await second.handle.close();
    assert.equal(second.path, join(dir, 'b-2.pdf'));
    assert.equal(readFileSync(target, 'utf8'), 'keep');
  }
});

test('checkAttachable enforces allowed roots, the deny list and dotenv files', async () => {
  const home = tempDir();
  mkdirSync(join(home, 'docs'));
  mkdirSync(join(home, '.ssh'));
  mkdirSync(join(home, 'project'));
  writeFileSync(join(home, 'docs', 'plan.pdf'), 'pdf');
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'key');
  writeFileSync(join(home, 'project', '.env.local'), 'X=1');
  const policy = { roots: ['~'], deny: ['~/.ssh', '**/.env*'], home };

  assert.equal(await checkAttachable('~/docs/plan.pdf', policy), join(await realpath(home), 'docs', 'plan.pdf'));
  await assert.rejects(checkAttachable('~/.ssh/id_ed25519', policy), /refusing to attach a file from ~\/\.ssh/);
  await assert.rejects(checkAttachable('~/project/.env.local', policy), /never attached/);
  await assert.rejects(checkAttachable('~/docs/missing.pdf', policy), /not found/);
  await assert.rejects(checkAttachable('~/docs', policy), /not a regular file/);
  const elsewhere = join(tempDir(), 'x.pdf');
  writeFileSync(elsewhere, 'x');
  await assert.rejects(checkAttachable(elsewhere, { ...policy, roots: [join(home, 'docs')] }), /outside them/);
  if (posix) {
    symlinkSync(join(home, '.ssh', 'id_ed25519'), join(home, 'docs', 'innocent.pdf'));
    await assert.rejects(checkAttachable('~/docs/innocent.pdf', policy), /refusing to attach a file from ~\/\.ssh/);
  }
});
