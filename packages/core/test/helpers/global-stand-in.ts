import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { UpdateDeps } from '../../src/operations/update.ts';
import { unpackTarball } from './tarball-fixture.ts';
import { tempDir } from './temp.ts';

/*
 * `npm install -g <file>` and `npm root -g`, stood in for (design 2026-10-22 P3): an update installs a global package
 * from the verified tarball it downloaded, written to a file, and then checks what is in the global folder against it.
 *
 * The stand-in does what npm does with that file, and no more: it unpacks the tarball — `package/*` — into
 * `<root>/<its name>`, in place of what was there, and records its version in `installed`, which a test's
 * `globalPackages` reads, as `npm ls -g` would. It unpacks with the fixture's own walker (`unpackTarball`), never the
 * reader under test. A test of what real npm leaves behind runs npm itself (`update-global.test.ts`).
 */

/** What a test's update deps take from it: both are set, so a test can call them too. */
export type GlobalStandIn = {
  [Key in 'installGlobal' | 'globalRoot']-?: NonNullable<UpdateDeps[Key]>;
};

export function globalStandIn(root: string, installed: Record<string, string>): GlobalStandIn {
  return {
    installGlobal: async (spec: string) => {
      const bytes = readFileSync(spec);
      // Its name and version, as npm reads them: from the manifest in the file.
      const staging = tempDir('comms-global-stand-in-');
      await unpackTarball(bytes, staging);
      const manifest = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
      };
      const target = join(root, ...manifest.name.split('/'));
      rmSync(target, { recursive: true, force: true });
      mkdirSync(dirname(target), { recursive: true });
      await unpackTarball(bytes, target);
      installed[manifest.name] = manifest.version;
    },
    globalRoot: async () => root,
  };
}
