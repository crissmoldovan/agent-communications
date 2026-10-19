import pkg from '../package.json' with { type: 'json' };

/** The package version, read from package.json at build time. */
export const VERSION: string = pkg.version;
