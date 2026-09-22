/** The versions of the config file a release can know about. See `READABLE_CONFIG_VERSIONS` in `config.ts`. */
export type ConfigVersion = 1 | 2;

/**
 * The version a brand-new config is created at.
 *
 * **2, from this release.** Version 2 names every account `organisation/platform`. The release before this one could
 * read version 2 and deliberately could not create it, so that every program sharing a config file — an MCP server
 * started last week, a CLI updated today — could read what the next one writes. That release is out; this is the one
 * that writes. Moving this constant also opens the gate in `release-gate.ts` that lets `ConfigStore.migrateNames`
 * run, because the two must never disagree.
 */
export const NEW_CONFIG_VERSION: ConfigVersion = 2;
