import { main } from '../../src/cli.ts';
import { releaseWorld } from '../helpers/release-world.ts';

/*
 * Core's CLI, as `agentcomms` runs it, for a test of the day's check it is handed (design 2026-10-22 P1, P2): run as a
 * child with `--experimental-strip-types`, in the environment and folders the test pins.
 *
 * The one difference is what core verifies a release with: the real verifier, reading npm's attestations from this
 * world's stand-in and Sigstore's trust root from the test's own. The registry's documents and the tarballs they point
 * at are read over `npm_config_registry`, which the test points at `loopbackRegistry` of the same world: a release's
 * tarball is the same bytes in every process, so what the test serves is what this world's attestation signs.
 *
 * The world: 99.0.0 declares a security fix in its tarball, and its registry document says nothing of one.
 */
const world = releaseWorld({ '@agentcomms/core': '99.0.0' }, [
  { version: '99.0.0', declares: { security: true }, registrySays: {} },
]);

process.exitCode = await main(process.argv.slice(2), process.env, process.platform, {
  update: { verifyRelease: world.verifyRelease },
});
