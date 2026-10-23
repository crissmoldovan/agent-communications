import { main } from '../../src/cli.ts';
import { VERSION } from '../../src/version.ts';
import { fixtureTarballs, registryOf, testReleaseVerifier } from '../helpers/provenance-fixture.ts';

/*
 * Core's CLI, as `agentcomms` runs it, for a test elsewhere — the root suite's real shells — that registers a server
 * with the managed or the npx launcher through it: run as a child with `--experimental-strip-types`, in the environment
 * and folders the test pins.
 *
 * The one difference is what core verifies a release with before it registers on that release's runtime (re-review of
 * 0.20.0, severity 4), or writes an npx entry whose client fetches it (design 2026-10-22 P5): the real verifier, reading npm's attestations from the fixture's stand-in and Sigstore's trust
 * root from the test's own, and a registry naming this release with the tarball the stand-in signs, served by the
 * fixture's own stand-in (`../helpers/provenance-fixture.ts`). A CLI started from a package's build reads npm's
 * registry and endpoint and Sigstore's root, which no test may reach, and nothing in its environment can tell it
 * otherwise.
 */
process.exitCode = await main(process.argv.slice(2), process.env, process.platform, {
  update: { registry: registryOf(() => VERSION), verifyRelease: testReleaseVerifier(), tarballs: fixtureTarballs },
});
