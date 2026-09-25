/**
 * A pnpm hook that records, in each published manifest, the commit the package was published from, as `gitHead`.
 *
 * `npm publish` writes `gitHead` on its own. pnpm 11 does not: its publish builds the manifest from `package.json`
 * and adds nothing of the kind, so the registry kept no record of which commit a version came from. The release
 * workflow needs one. It skips a package already at the tagged version only when that version was published from the
 * tagged commit (`scripts/release-ci.mjs pending`), and it refuses a version with no commit recorded, because it
 * cannot tell whether that one is a partial release being finished or a stray build of the same number.
 *
 * Every publish passes it, the workflow's and `scripts/release.mjs`'s alike, as
 * `--config.pnpmfile=scripts/record-git-head.cjs`. `scripts/verify-package.mjs` packs with it and reads the field
 * back, so a pnpm that stopped applying it fails the verify, before a version goes out that no later run can match.
 */
const { execFileSync } = require('node:child_process');

module.exports = {
  hooks: {
    beforePacking(manifest, dir) {
      // What `npm publish` records: the commit checked out where the package is. A failure here stops this package's
      // publish before it is sent, which is the right way round: without the field it could never be matched.
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
      if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) {
        throw new Error(`cannot record the commit ${manifest.name} is published from: git answered "${commit}"`);
      }
      return { ...manifest, gitHead: commit };
    },
  },
};
