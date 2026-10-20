/**
 * Runs E2's registered cargo-leg Laya mutants (E2 Task 11) under the strict rule: `pnpm verify` builds no Rust, so
 * `desktop.yml` runs this, on each of its legs, after the app's own `cargo test`. Before any registered mutant, it
 * proves the leg's runner refuses what is not a kill: a copy that does not build, an oracle that does not pass
 * unmutated, and a mutant its oracle accepts. Then every registered cargo mutant must run and be killed by its named
 * test, or this fails. The node and Vitest legs run in the daemon suite (`laya-mutations.test.ts`).
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning \
 *     packages/events-daemon/test/support/run-laya-mutants.ts --leg cargo
 */
import assert from 'node:assert/strict';
import {
  expectEveryLayaMutationToFail,
  expectLayaMutationToFail,
  type LayaMutation,
  layaMutationLeg,
} from './laya-mutants.ts';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--leg' || layaMutationLeg(args[1], '--leg') !== 'cargo') {
  process.stderr.write('usage: run-laya-mutants.ts --leg cargo (the node and Vitest legs run in pnpm verify)\n');
  process.exit(64);
}

/** A runner input over the app's own crate, never registered: version.rs and its first test. */
function probe(overrides: Partial<LayaMutation>): LayaMutation {
  const testName = overrides.testName ?? 'version::tests::a_version_is_at_least_what_a_feature_needs';
  return {
    id: 'cargo-runner-self-test',
    kind: 'production',
    leg: 'cargo',
    owner: 'task-11',
    source: 'apps/desktop/src-tauri/src/version.rs',
    testFile: 'apps/desktop/src-tauri/src/version.rs',
    before: 'pub fn at_least(installed: &str, needed: &str) -> bool {',
    after: '// an inert edit\npub fn at_least(installed: &str, needed: &str) -> bool {',
    ...overrides,
    testName,
    testPattern: testName,
  };
}

await assert.rejects(
  expectLayaMutationToFail(probe({ after: 'pub fn at_least_renamed(installed: &str, needed: &str) -> bool {' })),
  /its named test, not the build, failed/u,
  'a copy that does not build is not a kill',
);
await assert.rejects(
  expectLayaMutationToFail(probe({ testName: 'version::tests::an_oracle_this_crate_does_not_have' })),
  /the unmutated copy did not run exactly its named test/u,
  'an oracle that does not pass unmutated is not a kill',
);
await assert.rejects(
  expectLayaMutationToFail(probe({})),
  /unexpectedly accepted mutant/u,
  'a mutant its oracle accepts is not a kill',
);
process.stdout.write(
  'Laya cargo leg: the runner refuses a copy that does not build, an absent oracle and a survivor\n',
);

const results = await expectEveryLayaMutationToFail({ legs: ['cargo'] });
assert.ok(results.length > 0, 'the cargo leg has registered mutants');
for (const { mutation, changedLine } of results) {
  process.stdout.write(`killed ${mutation.id}: ${mutation.source}:${changedLine} -> ${mutation.testName}\n`);
}
process.stdout.write(`Laya cargo leg: ${results.length} mutants, each killed by its named test\n`);
