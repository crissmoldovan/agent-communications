import { cp } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Package-root assets the daemon's production code reads at run time: the reviewed Laya manifest, runtime lock and
 * enablement disclosures. A mutant tree that copies only src/ and test/ must carry them too, or a production path
 * fails on a missing file instead of on its mutant.
 */
export const SHIPPED_PACKAGE_ASSETS: readonly string[] = Object.freeze([
  'laya-manifest.json',
  'laya-runtime.json',
  'laya-enablement-disclosures.json',
]);

export async function copyShippedPackageAssets(packageRoot: string, root: string): Promise<void> {
  await Promise.all(SHIPPED_PACKAGE_ASSETS.map((name) => cp(join(packageRoot, name), join(root, name))));
}
