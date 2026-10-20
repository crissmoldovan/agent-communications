import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type RuntimeTreeFile, validateRuntimeTreeFiles } from './tar.ts';

export type RuntimeTreeVerification =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | 'TREE_EXECUTABLE'
        | 'TREE_EXTRA'
        | 'TREE_HASH'
        | 'TREE_IO'
        | 'TREE_MISSING'
        | 'TREE_SIZE'
        | 'TREE_TYPE'
        | 'TREE_EXPECTED';
    };

function expectedFiles(files: readonly RuntimeTreeFile[]): Map<string, RuntimeTreeFile> | null {
  try {
    return new Map(validateRuntimeTreeFiles(files));
  } catch {
    return null;
  }
}

function expectedDirectories(expected: ReadonlyMap<string, RuntimeTreeFile>): ReadonlySet<string> {
  const directories = new Set<string>();
  for (const path of expected.keys()) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join('/'));
  }
  return directories;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyDirectory(
  root: string,
  relative: string,
  expected: Map<string, RuntimeTreeFile>,
  directories: ReadonlySet<string>,
): Promise<RuntimeTreeVerification> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(join(root, relative), { encoding: 'utf8', withFileTypes: true });
  } catch {
    return { ok: false, code: 'TREE_IO' };
  }
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  for (const entry of entries) {
    const relativePath = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(join(root, relativePath));
    } catch {
      return { ok: false, code: 'TREE_IO' };
    }
    if (info.isDirectory()) {
      if (!directories.has(relativePath)) return { ok: false, code: 'TREE_EXTRA' };
      const child = await verifyDirectory(root, relativePath, expected, directories);
      if (!child.ok) return child;
      continue;
    }
    const expectedFile = expected.get(relativePath);
    if (expectedFile === undefined) return { ok: false, code: 'TREE_EXTRA' };
    if (!info.isFile()) return { ok: false, code: 'TREE_TYPE' };
    if (info.size !== expectedFile.size) return { ok: false, code: 'TREE_SIZE' };
    const executable = (info.mode & 0o111) !== 0;
    if (executable !== expectedFile.executable) return { ok: false, code: 'TREE_EXECUTABLE' };
    let digest: string;
    try {
      digest = await sha256(join(root, relativePath));
    } catch {
      return { ok: false, code: 'TREE_IO' };
    }
    if (digest !== expectedFile.sha256) return { ok: false, code: 'TREE_HASH' };
    expected.delete(relativePath);
  }
  return { ok: true };
}

/** Compares the complete selected runtime or model tree without following links or returning a path. */
export async function verifyRuntimeTree(options: {
  readonly root: string;
  readonly files: readonly RuntimeTreeFile[];
}): Promise<RuntimeTreeVerification> {
  const expected = expectedFiles(options.files);
  if (expected === null) return { ok: false, code: 'TREE_EXPECTED' };
  try {
    const root = await lstat(options.root);
    if (!root.isDirectory() || root.isSymbolicLink()) return { ok: false, code: 'TREE_TYPE' };
  } catch {
    return { ok: false, code: 'TREE_MISSING' };
  }
  const result = await verifyDirectory(options.root, '', expected, expectedDirectories(expected));
  if (!result.ok) return result;
  return expected.size === 0 ? { ok: true } : { ok: false, code: 'TREE_MISSING' };
}
