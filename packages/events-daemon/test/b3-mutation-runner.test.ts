import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { EventControlClient } from '../src/control/client.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { runB3Mutation } from './support/b3-mutants.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const ROOT = join(import.meta.dirname, '../../..');
const OWNER_CASE = 'owner-b3-operation-closed-set';

interface GuardEntry extends Record<string, unknown> {
  readonly case: string;
  readonly mutation: { readonly from: string; readonly to: string };
  readonly mutationTest: string;
  readonly loadedMarker: string;
  readonly overlayInputs?: readonly string[];
}

async function entries(): Promise<readonly GuardEntry[]> {
  const load = (path: string): Promise<unknown> => import(path);
  const verifier = (await load('../../../scripts/verify-b3-guard-coverage.mjs')) as {
    readB3GuardManifests(root: string): Promise<readonly { readonly cases: readonly GuardEntry[] }[]>;
    verifyB3GuardCoverage(input: { readonly root: string }): Promise<readonly string[]>;
  };
  const problems = await verifier.verifyB3GuardCoverage({ root: ROOT });
  assert.deepEqual(problems, [], 'the complete B3 manifest ledger must be structurally valid before it is executed');
  return (await verifier.readB3GuardManifests(ROOT)).flatMap((manifest) => manifest.cases);
}

test('B3 mutation proof: a sealed owner dispatches only B3 contract operations', { skip: WINDOWS_SKIP }, async () => {
  if (process.env.B3_MUTATION_CASE !== OWNER_CASE) return;
  const stateDir = await shortTempDir('aev-b3-owner-');
  const seen: unknown[] = [];
  const owner = await startEventOwner({
    stateDir,
    b3OwnerService: {
      async handle(request) {
        seen.push(request);
        return { accepted: request.operation };
      },
    },
  });
  try {
    const client = new EventControlClient({ stateDir, clientName: 'events-daemon-b3-mutation-test' });
    assert.deepEqual(await client.request('targetTest', { fixture: 'b3-control' }), { accepted: 'targetTest' });
    await assert.rejects(
      () => client.request('not-a-b3-operation', { fixture: 'b3-control' }),
      (error: unknown) =>
        (error as { readonly code?: unknown }).code === 'USAGE' &&
        (error as Error).message === 'the local event control operation is not recognised',
      'an unknown control operation must not cross into the B3 owner service',
    );
    assert.deepEqual(seen, [
      {
        operation: 'targetTest',
        args: { fixture: 'b3-control' },
        origin: 'events-daemon-b3-mutation-test',
      },
    ]);
  } finally {
    await owner.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 mutation runner executes every case in every B3 guard manifest', async (t) => {
  const declared = await entries();
  assert.ok(declared.length > 0, 'the ledger must contain at least one production guard');
  const blocked: string[] = [];
  const failures: string[] = [];
  for (const entry of declared) {
    try {
      const result = await runB3Mutation({ root: ROOT, entry });
      assert.match(result.output, new RegExp(`B3_MUTANT_LOADED:${entry.loadedMarker}`));
      assert.notEqual(result.status, 0, `${entry.case}: the named production-path test must fail under its mutant`);
    } catch (error) {
      if (error instanceof Error && /\bEPERM\b/u.test(error.message)) {
        blocked.push(entry.case);
        continue;
      }
      failures.push(`${entry.case}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.deepEqual(failures, [], 'every non-EPERM B3 mutation case must prove its named mutant');
  if (blocked.length > 0) t.skip(`EPERM-only B3 mutation cases in this sandbox: ${blocked.join(', ')}`);
});

test('B3 mutation runner copies declared glob inputs, snapshots every non-generated repository input, and proves the named case green before mutating it', async () => {
  const entry = (await entries()).find((candidate) => candidate.case === 'paired-capability-row-cannot-be-deleted');
  assert.ok(entry, 'the surface ledger declares every registry input its named parity case reads');
  assert.deepEqual(entry.overlayInputs, ['package.json', 'capabilities.json', 'packages/*/package.json', 'scripts/**']);
  const result = await runB3Mutation({ root: ROOT, entry });
  assert.match(result.baseline.output, new RegExp(`ok 1 - ${entry.mutationTest}`));
  assert.match(result.baseline.output, /# tests 1\n/);
  assert.match(result.baseline.output, /# pass 1\n/);
  assert.match(result.baseline.output, /# fail 0\n/);
  assert.match(result.output, new RegExp(`not ok 1 - ${entry.mutationTest}`));
  assert.match(result.output, /# tests 1\n/);
  assert.match(result.output, /# fail 1\n/);
  assert.equal(
    result.baseline.completeRepositorySnapshot,
    true,
    'a parity baseline owns every non-generated repository input it might name with fs',
  );
});

test('B3 mutation runner refuses a case whose unmutated named test is not green', async () => {
  const entry: GuardEntry = {
    case: 'missing-named-baseline',
    operation: 'B3_CONTROL_CONTRACT',
    productionEntry: 'packages/events-daemon/src/operations/b3-contract.ts',
    test: 'packages/events-daemon/test/b3-capability-contract.test.ts',
    mutation: { from: "version: 'b3-control-v1'", to: "version: 'b3-control-v1'" },
    mutationTest: 'a test name that is not present',
    loadedMarker: 'missing-named-baseline',
  };
  await assert.rejects(
    () => runB3Mutation({ root: ROOT, entry }),
    /unmutated overlay named test did not pass: a test name that is not present/,
  );
});

test('B3 mutation runner rejects a normal-source import and a suppressed marker', async () => {
  const entry = (await entries())[0];
  assert.ok(entry, 'the proof substrate must register one mutation case');
  await assert.rejects(
    () => runB3Mutation({ root: ROOT, entry, forceNormalSource: true }),
    /mutated module did not load/,
  );
  await assert.rejects(
    () => runB3Mutation({ root: ROOT, entry, suppressLoadedMarker: true }),
    /mutated module did not load/,
  );
});

test('B3 mutation runner rejects a mutant whose source module was never loaded', async () => {
  const entry = (await entries())[0];
  assert.ok(entry, 'the proof substrate must register one mutation case');
  await assert.rejects(
    () => runB3Mutation({ root: ROOT, entry, omitMutantSource: true }),
    /mutated module did not load/,
  );
});

test('B3 mutation runner rejects an unrelated process failure after its named test passed', async () => {
  const entry: GuardEntry = {
    case: 'tap-named-case',
    operation: 'B3_CONTROL_CONTRACT',
    productionEntry: 'packages/events-daemon/src/operations/b3-contract.ts',
    test: 'packages/events-daemon/test/b3-capability-contract.test.ts',
    mutation: { from: "version: 'b3-control-v1'", to: "version: 'b3-control-v1'" },
    mutationTest:
      'B3 contract exports data-only approval and E/E2 result grammars for desktop and future judge consumers',
    loadedMarker: 'tap-named-case',
  };
  await assert.rejects(
    () => runB3Mutation({ root: ROOT, entry, failAfterNamedTest: true }),
    /mutant named test did not fail exactly once/,
  );
});
