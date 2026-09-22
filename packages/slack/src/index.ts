/**
 * The library entry of `@agentcomms/slack`.
 *
 * Deliberately small. Everything else in this package is reached through the `agent-slack` command, which ships
 * as a bundle with no runtime dependencies — so what is exported here stays a contract that can be kept, rather
 * than the whole internal surface.
 */
import { VERSION } from './version.ts';

export { VERSION };
export const PACKAGE_NAME = '@agentcomms/slack';

export * from './api/guard.ts';
export * from './api/methods.ts';
