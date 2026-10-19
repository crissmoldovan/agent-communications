import { startCoreStdioServer } from '../../src/mcp/server.ts';
import { testReleaseVerifier } from '../helpers/provenance-fixture.ts';

/*
 * Core's MCP server over stdio, as `agentcomms mcp` serves it, for a test in another package that drives an update
 * through it: run as a child with `--experimental-strip-types`, in the environment the test pins.
 *
 * The one difference is what verifies a release's provenance before the update installs or registers it: the real
 * verifier, reading npm's attestations from the fixture's stand-in and Sigstore's trust root from the test's own
 * (`../helpers/provenance-fixture.ts`). A server started from a package's build reads npm's endpoint and Sigstore's
 * root, which no test may reach, and nothing in its environment can tell it otherwise.
 */
await startCoreStdioServer({ env: process.env, update: { verifyRelease: testReleaseVerifier() } });
