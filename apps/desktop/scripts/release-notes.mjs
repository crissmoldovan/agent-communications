#!/usr/bin/env node
/**
 * The notes of a `desktop-vX.Y.Z` release (desktop design DA8): `node apps/desktop/scripts/release-notes.mjs X.Y.Z`
 * prints them. The release workflow makes the draft with them, and so does `publish-desktop.sh` when it finds none.
 *
 * Four lines, and the third is the one that matters: the Windows and Linux files come from CI unsigned, so the
 * person downloading them is told before their system says it.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VERSION = /^\d+\.\d+\.\d+$/;

/** The four lines, for a version `X.Y.Z`. Throws for anything else. */
export function releaseNotes(version) {
  if (!VERSION.test(String(version))) throw new Error(`not a release version: ${JSON.stringify(version)}`);
  return [
    `Agent Comms ${version}.`,
    'macOS: the DMG is signed with a Developer ID and notarised.',
    'Windows and Linux: the .exe, .AppImage and .deb are unsigned; your system warns before it opens them.',
    `What changed: CHANGELOG.md, ${version}.`,
  ].join('\n');
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.stdout.write(`${releaseNotes(process.argv[2])}\n`);
  } catch (error) {
    console.error(`usage: release-notes.mjs X.Y.Z (${error.message})`);
    process.exit(1);
  }
}
