#!/usr/bin/env node
/**
 * The updater's `latest.json` for a signed macOS release (desktop design DA8), which `publish-desktop.sh` uploads:
 *
 *   node apps/desktop/scripts/updater-manifest.mjs <owner/repo> desktop-vX.Y.Z <archive.tar.gz.sig> > latest.json
 *
 * The build is universal, so both Mac architectures name the one archive and its signature. The archive's address is
 * the release's public download, because the app carries no token (the repository is public), and the app finds the
 * manifest itself through the GitHub API among the `desktop-v*` releases.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The archive `release-desktop.sh` stages and `publish-desktop.sh` uploads. */
export const ARCHIVE = 'Agent.Comms.app.tar.gz';

/** `latest.json`'s object, for a `desktop-vX.Y.Z` tag. Throws for another tag, repository or an empty signature. */
export function updaterManifest({ repo, tag, signature, pubDate = new Date() }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo))) throw new Error(`not a repository: ${JSON.stringify(repo)}`);
  const version = /^desktop-v(\d+\.\d+\.\d+)$/.exec(String(tag))?.[1];
  if (version === undefined) throw new Error(`not a desktop release tag: ${JSON.stringify(tag)}`);
  const signed = String(signature ?? '').trim();
  if (signed === '') throw new Error('the archive signature is empty');
  const url = `https://github.com/${repo}/releases/download/${tag}/${ARCHIVE}`;
  return {
    version,
    notes: `Agent Comms ${version}`,
    pub_date: pubDate.toISOString(),
    platforms: {
      'darwin-aarch64': { signature: signed, url },
      'darwin-x86_64': { signature: signed, url },
    },
  };
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [repo, tag, signatureFile] = process.argv.slice(2);
    if (!signatureFile) throw new Error('three arguments are needed');
    const manifest = updaterManifest({ repo, tag, signature: readFileSync(signatureFile, 'utf8') });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    console.error(`usage: updater-manifest.mjs <owner/repo> desktop-vX.Y.Z <archive.sig> (${error.message})`);
    process.exit(1);
  }
}
