#!/usr/bin/env node
/**
 * Whether a signed macOS release carries the app's updater (desktop design DA8; DA16, after review), which
 * `release-desktop.sh` asks before it reads the signing environment:
 *
 *   node apps/desktop/scripts/updater-key.mjs <updater key file> [<tauri.conf.json>]
 *
 * It prints `on` or `off`, and exits 1 with the reason when the release cannot go ahead.
 * - **off:** `plugins.updater.pubkey` in `tauri.conf.json` is empty. The release is still built, signed and notarised,
 *   with no updater artefacts, and its app has its updater off: what to do to turn it on is said, loudly, on stderr.
 * - **on:** the pubkey is set, and the key beside it is there, has mode 600, and its `.pub` is that pubkey.
 * - **refused:** the pubkey is set, and the key is missing, readable by others, or not the pubkey's.
 *
 * It never prints the key.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, '..', 'src-tauri', 'tauri.conf.json');

/** What a release without the updater key says, so nobody takes its silence for an updater that works. */
export const OFF_NOTICE = [
  '',
  '  ┌──────────────────────────────────────────────────────────────────────────────────────────────┐',
  '  │ THE UPDATER IS OFF FOR THIS RELEASE                                                          │',
  '  └──────────────────────────────────────────────────────────────────────────────────────────────┘',
  '  plugins.updater.pubkey in apps/desktop/src-tauri/tauri.conf.json is empty, so this build carries no',
  '  updater artefacts, publish-desktop.sh uploads no latest.json, and the app it installs never updates',
  '  itself: each copy is replaced by hand until a later release has the updater on.',
  '  To turn it on (docs/RELEASING.md, "The desktop app"):',
  '    1. pnpm --filter @agentcomms/desktop tauri signer generate -w ~/.agentcomms/tauri-updater.key',
  '       chmod 600 ~/.agentcomms/tauri-updater.key',
  '    2. paste the contents of ~/.agentcomms/tauri-updater.key.pub into plugins.updater.pubkey, and commit it;',
  '    3. release the next version.',
  '',
].join('\n');

/**
 * The decision, from what is read: `pubkey` from the config, and for the key file whether it and its `.pub` are there,
 * the key's mode, and the `.pub`'s text. Returns `{ updater: 'on' | 'off' }`, or throws an Error saying why not.
 */
export function updaterDecision({ pubkey, keyFile, keyMode, publicKey }) {
  const wanted = typeof pubkey === 'string' ? pubkey.trim() : '';
  if (wanted === '') return { updater: 'off' };
  if (keyMode === null || publicKey === null) {
    throw new Error(`the updater key pair is missing: ${keyFile} and ${keyFile}.pub.`);
  }
  if ((keyMode & 0o777) !== 0o600) {
    throw new Error(`${keyFile} must have mode 600, not ${(keyMode & 0o777).toString(8)}: chmod 600 it.`);
  }
  if (publicKey.trim() !== wanted) {
    throw new Error(`the .pub beside ${keyFile} is not plugins.updater.pubkey in tauri.conf.json.`);
  }
  return { updater: 'on' };
}

/** Reads what `updaterDecision` needs from disk. */
export function readUpdaterInputs(keyFile, configFile = CONFIG) {
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const modeOf = (path) => {
    try {
      return statSync(path).isFile() ? statSync(path).mode : null;
    } catch {
      return null;
    }
  };
  const keyMode = modeOf(keyFile);
  let publicKey = null;
  try {
    publicKey = modeOf(`${keyFile}.pub`) === null ? null : readFileSync(`${keyFile}.pub`, 'utf8');
  } catch {
    publicKey = null;
  }
  return { pubkey: config.plugins?.updater?.pubkey ?? '', keyFile, keyMode, publicKey };
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  const [keyFile, configFile] = process.argv.slice(2);
  if (!keyFile) {
    console.error('usage: updater-key.mjs <updater key file> [<tauri.conf.json>]');
    process.exit(1);
  }
  try {
    const { updater } = updaterDecision(readUpdaterInputs(keyFile, configFile));
    if (updater === 'off') process.stderr.write(OFF_NOTICE);
    process.stdout.write(`${updater}\n`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
