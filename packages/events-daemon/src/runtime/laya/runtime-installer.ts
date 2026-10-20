import { chmod, lstat, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { extractPackageArchive, LayaTarError, type RuntimeTreeFile, type TarSource } from './tar.ts';
import { verifyRuntimeTree } from './tree-verifier.ts';

const OWNER_ONLY_DIRECTORY_MODE = 0o700;

export interface RuntimeInstallFile extends RuntimeTreeFile {
  readonly packageName: string;
}

export interface RuntimePackageArchive {
  readonly packageName: string;
  readonly source: TarSource;
}

export type LayaRuntimeInstallErrorCode =
  | 'RUNTIME_DIGEST'
  | 'RUNTIME_EXISTS'
  | 'RUNTIME_INCOMPLETE'
  | 'RUNTIME_PATH'
  | 'RUNTIME_TREE';

export class LayaRuntimeInstallError extends Error {
  readonly code: LayaRuntimeInstallErrorCode;

  constructor(code: LayaRuntimeInstallErrorCode) {
    super(`Laya runtime installation refused: ${code}`);
    this.name = 'LayaRuntimeInstallError';
    this.code = code;
  }
}

function isSafePackageName(packageName: string): boolean {
  const parts = packageName.split('/');
  return (
    (parts.length === 1 || (parts.length === 2 && parts[0] !== undefined && parts[0].startsWith('@'))) &&
    parts.every((part) => /^[a-z0-9][a-z0-9._-]*$/i.test(part.replace(/^@/, '')) && part !== '.' && part !== '..')
  );
}

async function ownerOnlyDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new LayaRuntimeInstallError('RUNTIME_PATH');
  await chmod(path, OWNER_ONLY_DIRECTORY_MODE);
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new LayaRuntimeInstallError('RUNTIME_EXISTS');
}

function filesForPackage(packageName: string, files: readonly RuntimeInstallFile[]): readonly RuntimeTreeFile[] {
  const prefix = `node_modules/${packageName}/`;
  const selected: RuntimeTreeFile[] = [];
  for (const file of files) {
    if (file.packageName !== packageName || !file.path.startsWith(prefix)) {
      if (file.packageName === packageName) throw new LayaRuntimeInstallError('RUNTIME_PATH');
      continue;
    }
    selected.push({ ...file, path: file.path.slice(prefix.length) });
  }
  return selected;
}

function validateInstallation(packages: readonly RuntimePackageArchive[], files: readonly RuntimeInstallFile[]): void {
  const packageNames = new Set<string>();
  for (const runtimePackage of packages) {
    if (!isSafePackageName(runtimePackage.packageName) || packageNames.has(runtimePackage.packageName)) {
      throw new LayaRuntimeInstallError('RUNTIME_PATH');
    }
    packageNames.add(runtimePackage.packageName);
  }
  for (const file of files) {
    if (!packageNames.has(file.packageName)) throw new LayaRuntimeInstallError('RUNTIME_PATH');
    if (!file.path.startsWith(`node_modules/${file.packageName}/`)) throw new LayaRuntimeInstallError('RUNTIME_PATH');
  }
}

/** Installs a complete selected lock tree into an owner-only partial directory and atomically promotes it once. */
export async function installRuntime(options: {
  readonly runtimeDirectory: string;
  readonly lockDigest: string;
  readonly packages: readonly RuntimePackageArchive[];
  readonly files: readonly RuntimeInstallFile[];
}): Promise<{ readonly root: string }> {
  if (!/^[a-f0-9]{64}$/.test(options.lockDigest)) throw new LayaRuntimeInstallError('RUNTIME_DIGEST');
  validateInstallation(options.packages, options.files);
  await ownerOnlyDirectory(options.runtimeDirectory);
  const root = join(options.runtimeDirectory, options.lockDigest);
  const partial = `${root}.partial`;
  await assertAbsent(root);
  await rm(partial, { recursive: true, force: true });
  await ownerOnlyDirectory(partial);
  try {
    for (const runtimePackage of options.packages) {
      const files = filesForPackage(runtimePackage.packageName, options.files);
      await extractPackageArchive({
        source: runtimePackage.source,
        destination: join(partial, 'node_modules', runtimePackage.packageName),
        files,
      });
    }
    const verified = await verifyRuntimeTree({ root: partial, files: options.files });
    if (!verified.ok) throw new LayaRuntimeInstallError('RUNTIME_TREE');
    await assertAbsent(root);
    await rename(partial, root);
    return { root };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    if (error instanceof LayaTarError && error.code === 'TAR_MISSING') {
      throw new LayaRuntimeInstallError('RUNTIME_INCOMPLETE');
    }
    throw error;
  }
}
