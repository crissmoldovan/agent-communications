import { NEW_CONFIG_VERSION } from './config-version.ts';

/**
 * Whether this release may write version 2 of the config.
 *
 * Not while any reader that shares the file might still be one that cannot read it. So the release that teaches every
 * package to read version 2 does not write it — not through a command, and not through the library either:
 * `ConfigStore.migrateNames` is reachable from `openCore().config`, and an exported writer is a public one whoever
 * calls it. It follows the version a new config is created at, so the writer release flips one constant and both
 * move together.
 *
 * Deliberately not exported from the package root. Core's own tests exercise the transition through
 * `enableNamesMigrationForTests`, imported from this file by path, which no consumer of the package can reach.
 */
let enabled = NEW_CONFIG_VERSION === 2;

export function namesMigrationEnabled(): boolean {
  return enabled;
}

export function enableNamesMigrationForTests(): void {
  enabled = true;
}
