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

/*
 * The guard is **not** exported, and that is the point of it.
 *
 * It was, and exporting it handed every caller `closedPermit()` and `spendOn()` — so anything importing this
 * package could mint its own permit and open the door the guard exists to keep shut. A boundary whose key is
 * part of the public API is not a boundary; it is a convention with good manners.
 *
 * It stays internal, reached only through this package's own transport when S3 builds one. The method registry
 * below is different: it is a description of what this package may call, useful to read and impossible to abuse,
 * since knowing a method's name grants nothing.
 */
export * from './api/methods.ts';
