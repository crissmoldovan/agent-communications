/** The versions of the config file a release can know about. See `READABLE_CONFIG_VERSIONS` in `config.ts`. */
export type ConfigVersion = 1 | 2;

/**
 * The version a brand-new config is created at.
 *
 * Still 1. Nothing may write version 2 until every reader that shares the file can read it, so this release reads
 * version 2 and never creates it. The release that writes it changes this constant, and with it the gate in
 * `release-gate.ts` that lets `ConfigStore.migrateNames` run.
 */
export const NEW_CONFIG_VERSION: ConfigVersion = 1;
