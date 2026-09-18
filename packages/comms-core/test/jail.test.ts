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
  // Control characters are removed rather than replaced: they are never part of a name anyone meant to give.
  assert.equal(safeFilename(`in${NUL}voice${BEL}.pdf`), 'invoice.pdf');
  // A tab still becomes a separator-safe placeholder, because it is whitespace a name could legitimately contain.
  assert.equal(safeFilename('in\tvoice.pdf'), 'in_voice.pdf');
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

test('the default deny list covers every hidden folder in home, git folders and app data', async () => {
  const { defaultAttachDeny } = await import('../src/jail.ts');
  const home = tempDir();
  for (const dir of ['.config/gh', '.cursor', 'docs', 'repo/.git', 'Library/Cookies']) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'x');
  writeFileSync(join(home, '.cursor', 'mcp.json'), 'x');
  writeFileSync(join(home, 'docs', 'ok.pdf'), 'x');
  writeFileSync(join(home, 'repo', '.git', 'config'), 'x');
  writeFileSync(join(home, 'Library', 'Cookies', 'c'), 'x');
  const policy = { roots: ['~'], deny: defaultAttachDeny(join(home, '.config', 'agent-communications'), {}), home };
  assert.ok(await checkAttachable('~/docs/ok.pdf', policy));
  await assert.rejects(checkAttachable('~/.config/gh/hosts.yml', policy), /hidden folders in your home/);
  await assert.rejects(checkAttachable('~/.cursor/mcp.json', policy), /hidden folders in your home/);
  await assert.rejects(checkAttachable('~/repo/.git/config', policy), /\.git folder/);
  await assert.rejects(checkAttachable('~/Library/Cookies/c', policy), /from ~\/Library/);
});

test('a name that lies about what it is loses the characters doing the lying', () => {
  const rlo = String.fromCodePoint(0x202e);
  const zwj = String.fromCodePoint(0x200b);
  // Displayed as `invoiceexe.pdf` by a file manager; it is an executable.
  assert.equal(safeFilename(`invoice${rlo}fdp.exe`), 'invoicefdp.exe');
  assert.equal(safeFilename(`re${zwj}port.pdf`), 'report.pdf');
  // An ordinary name is untouched, accents and all.
  assert.equal(safeFilename('Rapport financier — août.pdf'), 'Rapport financier — août.pdf');
});
