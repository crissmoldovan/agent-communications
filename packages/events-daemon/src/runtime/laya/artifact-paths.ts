import { join, resolve, sep } from 'node:path';
import type { LayaManifestFile } from './contracts.ts';

export class LayaArtifactPathError extends Error {
  readonly code = 'ARTIFACT_PATH';

  constructor() {
    super('Laya artifact path is outside the reviewed artifact tree');
    this.name = 'LayaArtifactPathError';
  }
}

function safeSegment(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(value) && value !== '.' && value !== '..';
}

function safeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !/[\uD800-\uDFFF]/u.test(value) &&
    value.normalize('NFC') === value &&
    value.split('/').every(safeSegment)
  );
}

function below(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (!resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) throw new LayaArtifactPathError();
  return resolvedTarget;
}

export interface LayaModelArtifactPaths {
  readonly models: string;
  readonly partial: string;
  readonly complete: string;
  file(file: Pick<LayaManifestFile, 'path'>, state: 'partial' | 'complete'): string;
}

/** Derives owner-controlled locations only from the reviewed manifest identity and file list. */
export function layaModelArtifactPaths(dataDirectory: string, manifestId: string): LayaModelArtifactPaths {
  if (!safeSegment(manifestId)) throw new LayaArtifactPathError();
  const models = below(dataDirectory, join(dataDirectory, 'models'));
  const partial = below(models, join(models, `${manifestId}.partial`));
  const complete = below(models, join(models, manifestId));
  return {
    models,
    partial,
    complete,
    file(file, state) {
      if (!safeRelativePath(file.path)) throw new LayaArtifactPathError();
      return below(state === 'partial' ? partial : complete, join(state === 'partial' ? partial : complete, file.path));
    },
  };
}
