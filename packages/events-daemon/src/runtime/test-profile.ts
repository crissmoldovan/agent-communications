import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { accountHome, resolvePaths, TEST_PROFILE_MARKER } from '@agentcomms/core';

/*
 * The local test build's own test profile (security review of 0.34.0, finding 1). `scripts/local-test-release.sh` makes
 * one folder holding the profile's `config` and `state` folders, and marks both with core's `TEST_PROFILE_MARKER`.
 * The Agent Comms test build is ad-hoc signed, so any home-made app can say it is one: it speaks only for that profile,
 * never for the person's real installation. Core's `desktopAppOrigin` checks the config folder the CLI was given; the
 * act goes to the event service of the state folder it was given, so both are checked here as well — by the CLI, that
 * the two folders are one profile's, and by the event service, that its own state folder is a test profile's. A speed
 * bump against agents, as the origin is: code running as the person can write a mark too.
 */

/** A path as it really is: its nearest existing folder's real path, and the rest as given. */
function real(path: string): string {
  const absolute = resolve(path);
  const rest: string[] = [];
  let at = absolute;
  for (;;) {
    try {
      return join(realpathSync(at), ...rest);
    } catch {
      const parent = dirname(at);
      if (parent === at) return absolute;
      rest.unshift(basename(at));
      at = parent;
    }
  }
}

/** Whether `child` is `parent` or inside it, both as they really are. */
function inside(child: string, parent: string): boolean {
  const between = relative(real(parent), real(child));
  return between === '' || (!between.startsWith('..') && !isAbsolute(between));
}

/** Whether `path` is a file of its own: not a link, a folder or missing. */
function isPlainFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The CLI's check of a test build's command: its config folder and its state folder are both in the test profile's
 * folder, the one the (marked) config folder is in.
 */
export function withinTestProfile(configDir: string, stateDir: string): boolean {
  const profile = dirname(real(configDir));
  return inside(configDir, profile) && inside(stateDir, profile);
}

/**
 * The event service's check of a test build's request: its own state folder holds the test profile's mark, as a plain
 * file, and is not the person's real, default state folder — found from the account's own home (`os.userInfo()`), never
 * from the environment, which the caller sets. `home` is a test's seam.
 */
export function isTestProfileState(stateDir: string, home: string = accountHome()): boolean {
  if (!isPlainFile(join(stateDir, TEST_PROFILE_MARKER))) return false;
  const defaultState = resolvePaths({ env: {}, home }).stateDir;
  return real(stateDir) !== real(defaultState);
}
