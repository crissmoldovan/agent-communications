import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
// @ts-expect-error The verifier is a repository executable with no declaration file.
import * as phaseEVerifier from '../../../scripts/verify-events-phase-e-tests.mjs';

const { verifyPhaseEJudgeSource, verifyPhaseEStaticGuards, verifyPhaseETestManifest } = phaseEVerifier;

const REPOSITORY_ROOT = join(import.meta.dirname, '../../..');

async function manifestFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentcomms-e3-manifest-copy-'));
  await Promise.all([
    cp(join(REPOSITORY_ROOT, 'packages/events-daemon/src'), join(root, 'packages/events-daemon/src'), {
      recursive: true,
    }),
    cp(join(REPOSITORY_ROOT, 'packages/events-daemon/test'), join(root, 'packages/events-daemon/test'), {
      recursive: true,
    }),
    cp(join(REPOSITORY_ROOT, 'packages/events-daemon/package.json'), join(root, 'packages/events-daemon/package.json')),
    cp(join(REPOSITORY_ROOT, 'package.json'), join(root, 'package.json')),
    cp(join(REPOSITORY_ROOT, 'scripts'), join(root, 'scripts'), { recursive: true }),
  ]);
  const packagePath = join(root, 'package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  await writeFile(packagePath, `${JSON.stringify({ ...packageJson, type: 'module' }, null, 2)}\n`);
  await symlink(join(REPOSITORY_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  await symlink(
    join(REPOSITORY_ROOT, 'packages/events-daemon/node_modules'),
    join(root, 'packages/events-daemon/node_modules'),
    'dir',
  );
  return root;
}

function assertProblemsInclude(actual: readonly string[], expected: readonly string[]): void {
  for (const problem of expected)
    assert.ok(actual.includes(problem), `expected verifier problem: ${problem}; got ${actual.join('; ')}`);
}

test('E3 scope: the Phase-E test manifest owns Tasks 1–2 and every initial B3 guard exactly once', async () => {
  const root = join(import.meta.dirname, '../../..');
  assert.deepEqual(await verifyPhaseETestManifest({ root }), []);
});

test('E3 scope: static guards reject hollow manifests, missing runners, unsealed network tests and test-local models', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentcomms-e3-manifest-'));
  try {
    const missingManifest = await verifyPhaseETestManifest({ root });
    assert.ok(
      missingManifest.includes(
        'missing Phase-E manifest: packages/events-daemon/test/fixtures/judges/case-manifest.json',
      ),
    );
    assert.ok(missingManifest.includes('Phase-E manifest must declare at least one case, guard, and mutation'));
    assert.ok(missingManifest.includes('required Phase-E guard row is absent: task-2-durable-schema'));
    await writeFile(join(root, 'production.ts'), 'export const guard = true;\n');
    await writeFile(join(root, 'test.ts'), "test('named production test', () => {});\n");
    const manifest = {
      version: 1,
      cases: [
        {
          id: 'orphan-case',
          task: 'E3',
          coverage: [],
          productionEntry: 'production.ts',
          test: 'test.ts',
          mutation: { id: 'orphan-mutation', test: 'named production test' },
        },
      ],
    };
    assertProblemsInclude(await verifyPhaseETestManifest({ root, manifest }), [
      'Phase-E manifest must declare at least one case, guard, and mutation',
      'orphan-case: coverage must name exactly one owned §5/Task guard',
      'orphan-case: mutation id is not owned by the manifest',
      'orphan-case: strict runner is missing or does not execute this case',
      'orphan-case: named test does not import its production entry',
    ]);

    assertProblemsInclude(
      await verifyPhaseETestManifest({ root, manifest: { version: 1, cases: [], guards: [], mutations: [] } }),
      ['Phase-E manifest must declare at least one case, guard, and mutation'],
    );

    assertProblemsInclude(
      await verifyPhaseETestManifest({
        root,
        manifest: { version: 1, requiredCoverage: ['§5 synthetic guard'], cases: [], guards: [], mutations: [] },
      }),
      ['Phase-E manifest must declare at least one case, guard, and mutation', 'unowned §5 row: §5 synthetic guard'],
    );
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }));
    await mkdir(join(root, 'packages/events-daemon/test/support'), { recursive: true });
    await writeFile(
      join(root, 'packages/events-daemon/test/support/judge-mutants.ts'),
      "export const PHASE_E_GATE_MUTATIONS = [{ id: 'network-mutation' }, { id: 'model-mutation' }, { id: 'closure-mutation' }];\n",
    );
    await writeFile(
      join(root, 'packages/events-daemon/test/judge-mutations.test.ts'),
      'for (const mutation of PHASE_E_GATE_MUTATIONS) void mutation;\n',
    );
    assertProblemsInclude(
      await verifyPhaseETestManifest({
        root,
        manifest: {
          version: 1,
          guards: [{ id: 'network-guard' }],
          mutations: [{ id: 'network-mutation' }],
          cases: [
            {
              id: 'network-case',
              coverage: ['network-guard'],
              productionEntry: 'production.ts',
              test: 'test.ts',
              mutation: { id: 'network-mutation', test: 'named production test' },
              strictRunner: 'judge-mutants',
              network: true,
            },
          ],
        },
      }),
      [
        'network-case: named test does not import its production entry',
        'network-case: judge network test requires the loopback-seal preload',
      ],
    );
    assertProblemsInclude(
      await verifyPhaseETestManifest({
        root,
        manifest: {
          version: 1,
          guards: [{ id: 'model-guard' }],
          mutations: [{ id: 'model-mutation' }],
          cases: [
            {
              id: 'model-case',
              coverage: ['model-guard'],
              productionEntry: 'test/support/model.ts',
              test: 'test.ts',
              mutation: { id: 'model-mutation', test: 'named production test' },
              strictRunner: 'judge-mutants',
            },
          ],
        },
      }),
      [
        'model-case: production entry must not be a test-local implementation substitute',
        'model-case: named test does not import its production entry',
      ],
    );

    assertProblemsInclude(
      await verifyPhaseETestManifest({
        root,
        manifest: {
          version: 1,
          guards: [{ id: 'runner-guard' }],
          mutations: [{ id: 'runner-mutation' }],
          cases: [
            {
              id: 'runner-case',
              coverage: ['runner-guard'],
              productionEntry: 'production.ts',
              test: 'test.ts',
              mutation: { id: 'runner-mutation', test: 'named production test' },
            },
          ],
        },
      }),
      [
        'runner-case: strict runner is missing or does not execute this case',
        'runner-case: named test does not import its production entry',
      ],
    );

    assertProblemsInclude(
      await verifyPhaseETestManifest({
        root,
        manifest: {
          version: 1,
          guards: [{ id: 'closure-guard' }],
          mutations: [{ id: 'closure-mutation' }],
          cases: [
            {
              id: 'closure-case',
              coverage: ['closure-guard'],
              productionEntry: 'production.ts',
              test: 'test.ts',
              mutation: { id: 'closure-mutation', test: 'named production test' },
              strictRunner: 'judge-mutants',
            },
          ],
        },
      }),
      ['closure-case: named test does not import its production entry'],
    );

    await mkdir(join(root, 'packages/events-daemon/src/runtime'), { recursive: true });
    await mkdir(join(root, 'packages/events-daemon/src/store'), { recursive: true });
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(
      join(root, 'packages/events-daemon/src/runtime/evaluate.ts'),
      "export const copiedKinds = ['typesafe', 'laya', 'local-endpoint'];\n",
    );
    await writeFile(
      join(root, 'packages/events-daemon/src/store/migrations.ts'),
      'const query = "DELETE FROM judge_budget_reservations WHERE work_scope = \'source-owned\' AND source = ?";\n',
    );
    await writeFile(
      join(root, 'scripts/verify-events-phase-e-prerequisites.mjs'),
      'const query = "DELETE FROM judge_budget_reservations WHERE work_scope = \'source-owned\' AND source = ?";\n',
    );
    assert.deepEqual(await verifyPhaseEStaticGuards({ root }), [
      'packages/events-daemon/src/runtime/evaluate.ts: judge kind literals must come from domain/lifecycle.ts',
      'packages/events-daemon/src/store/migrations.ts: source-owned judge SQL must bind account_id and source in the same statement',
      'scripts/verify-events-phase-e-prerequisites.mjs: source-owned judge SQL must bind account_id and source in the same statement',
    ]);
    assert.deepEqual(
      verifyPhaseEJudgeSource({
        file: 'packages/events-daemon/src/runtime/evaluate.ts',
        source: "export const copiedKinds = ['typesafe', 'laya', 'local-endpoint'];\n",
      }),
      ['packages/events-daemon/src/runtime/evaluate.ts: judge kind literals must come from domain/lifecycle.ts'],
    );
    assert.deepEqual(
      verifyPhaseEJudgeSource({
        file: 'packages/events-daemon/src/store/migrations.ts',
        source:
          'const query = "DELETE FROM judge_budget_reservations WHERE work_scope = \'source-owned\' AND source = ?";\n',
      }),
      [
        'packages/events-daemon/src/store/migrations.ts: source-owned judge SQL must bind account_id and source in the same statement',
      ],
    );

    assert.deepEqual(
      verifyPhaseEJudgeSource({
        file: 'src/runtime/judge-scope.ts',
        source:
          "const JUDGE_KINDS = ['typesafe', 'laya', 'local-endpoint'];\nconst sql = `DELETE FROM judge_budget_reservations WHERE work_scope = 'source-owned' AND source = ?`;\n",
      }),
      [
        'src/runtime/judge-scope.ts: judge kind literals must come from domain/lifecycle.ts',
        'src/runtime/judge-scope.ts: source-owned judge SQL must bind account_id and source in the same statement',
      ],
    );
    assert.deepEqual(
      verifyPhaseEJudgeSource({
        file: 'src/runtime/judge-scope.ts',
        source:
          "const sql = `DELETE FROM judge_budget_reservations WHERE work_scope = 'synthetic-test' AND judge_id = ?`;\n",
      }),
      ['src/runtime/judge-scope.ts: synthetic judge SQL must bind test_work_id in the same statement'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('E3 scope: required E-owned rows and imported strict-runner collections cannot be deleted from the manifest', async () => {
  const root = await manifestFixture();
  try {
    const manifestPath = join(root, 'packages/events-daemon/test/fixtures/judges/case-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      guards: { id: string }[];
      mutations: { id: string }[];
      cases: { id: string }[];
    };
    manifest.guards = manifest.guards.filter((entry) => entry.id !== 'task-2-durable-schema');
    manifest.mutations = manifest.mutations.filter((entry) => entry.id !== 'e2-durable-schema');
    manifest.cases = manifest.cases.filter((entry) => entry.id !== 'e2-durable-schema');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const problems = await verifyPhaseETestManifest({ root });
    assert.ok(
      problems.includes('required Phase-E guard row is absent: task-2-durable-schema'),
      `deleting a row from both manifest and runner must refuse: ${problems.join('; ')}`,
    );
    assert.ok(
      problems.includes('judge-task5-mutants: runner mutation has no manifest row: e2-durable-schema'),
      `runner collections, not the manifest, must be authoritative: ${problems.join('; ')}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('E4 scope: deleting every Task-4 row from its manifest and strict runner is refused', async () => {
  const root = await manifestFixture();
  try {
    const task4Rows = new Set([
      'e4-no-pointer-at-prepare',
      'e4-final-pointer-drift',
      'e4-claim-pointer-drift',
      'e4-disabled-judge-add',
      'e4-kind-disable-recovery',
      'e4-laya-before-intent',
    ]);
    const manifestPath = join(root, 'packages/events-daemon/test/fixtures/judges/case-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      guards: { id: string }[];
      mutations: { id: string }[];
      cases: { id: string }[];
    };
    manifest.guards = manifest.guards.filter((entry) => !task4Rows.has(entry.id));
    manifest.mutations = manifest.mutations.filter((entry) => !task4Rows.has(entry.id));
    manifest.cases = manifest.cases.filter((entry) => !task4Rows.has(entry.id));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(
      join(root, 'packages/events-daemon/test/support/judge-task4-mutants.ts'),
      'export const JUDGE_TASK4_MUTATIONS = [] as const;\n',
    );

    const problems = await verifyPhaseETestManifest({ root });
    for (const id of task4Rows)
      assert.ok(
        problems.includes(`required Phase-E guard row is absent: ${id}`),
        `removing ${id} from both manifest and runner must refuse: ${problems.join('; ')}`,
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('E3 scope: a strict runner whose loop only diagnoses mutations is rejected from a copied tree', async () => {
  const root = await manifestFixture();
  try {
    const testPath = join(root, 'packages/events-daemon/test/judge-mutations.test.ts');
    const source = await readFile(testPath, 'utf8');
    const loop = [
      'for (const mutation of PHASE_E_GATE_MUTATIONS) {',
      '    await expectJudgeMutationToFail(mutation);',
      '    verdicts.push({ id: mutation.id, killed: true });',
      '    context.diagnostic(`' + '$' + '{mutation.id}: ' + '$' + '{mutation.testName}`);',
      '  }',
    ].join('\n');
    assert.ok(source.includes(loop), 'fixture contains the strict E3 mutation loop');
    await writeFile(
      testPath,
      source.replace(loop, 'for (const mutation of PHASE_E_GATE_MUTATIONS) context.diagnostic(mutation.id);'),
    );
    const problems = await verifyPhaseETestManifest({ root });
    assert.ok(
      problems.includes('judge-mutants: mutation loop does not call expectJudgeMutationToFail with its loop mutation'),
      `a hollow strict runner must refuse: ${problems.join('; ')}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('E3 scope: static guards analyse each kind literal and each SQL statement independently', () => {
  const kindProblem = ['src/runtime/kinds.ts: judge kind literals must come from domain/lifecycle.ts'];
  assert.deepEqual(
    verifyPhaseEJudgeSource({
      file: 'src/runtime/kinds.ts',
      source: "const hosted = 'typesafe'; const embedded = 'laya'; const local = 'local-endpoint';",
    }),
    kindProblem,
    'separate constants cannot split the closed judge-kind vocabulary past the guard',
  );
  assert.deepEqual(
    verifyPhaseEJudgeSource({
      file: 'src/runtime/kinds.ts',
      source: "const kinds = { hosted: 'typesafe', embedded: 'laya', local: 'local-endpoint' };",
    }),
    kindProblem,
    'an object of judge-kind values cannot duplicate the canonical registry',
  );
  assert.deepEqual(
    verifyPhaseEJudgeSource({
      file: 'src/runtime/kinds.ts',
      source: 'const hosted = `typesafe`; const embedded = `laya`; const local = `local-endpoint`;',
    }),
    kindProblem,
    'no-substitution template literals cannot duplicate the canonical judge-kind registry',
  );
  assert.deepEqual(
    verifyPhaseEJudgeSource({
      file: 'src/runtime/kinds.ts',
      source: "const hosted = '\\x74ypesafe';",
    }),
    kindProblem,
    'an escaped string literal cannot disguise a canonical judge kind',
  );
  assert.deepEqual(
    verifyPhaseEJudgeSource({
      file: 'src/runtime/kinds.ts',
      source: "const open = '/*'; const hosted = 'typesafe'; const close = '*/';",
    }),
    kindProblem,
    'comment delimiters inside strings cannot hide a canonical judge kind',
  );
  assert.deepEqual(
    verifyPhaseEJudgeSource({
      file: 'src/runtime/kinds.ts',
      source: "const quote = /['\"]/; const hosted = 'typesafe';",
    }),
    kindProblem,
    'regular-expression quote characters cannot hide a canonical judge kind',
  );
  assert.deepEqual(
    verifyPhaseEJudgeSource({
      file: 'src/runtime/kinds.ts',
      source: 'const kinds = { typesafe: true, laya: true, "local-endpoint": true };',
    }),
    ['src/runtime/kinds.ts: judge kind literals must come from domain/lifecycle.ts'],
  );
  assert.deepEqual(
    verifyPhaseEJudgeSource({
      file: 'src/runtime/source.ts',
      source:
        "const statement = `DELETE FROM judge_budget_reservations WHERE work_scope = 'source-owned' AND source = ?`;\nconst account = 'account_id = ?';",
    }),
    ['src/runtime/source.ts: source-owned judge SQL must bind account_id and source in the same statement'],
  );
  assert.deepEqual(
    verifyPhaseEJudgeSource({
      file: 'src/runtime/synthetic.ts',
      source:
        "const statement = `DELETE FROM judge_budget_reservations WHERE work_scope = 'synthetic-test'`;\nconst work = 'test_work_id = ?';",
    }),
    ['src/runtime/synthetic.ts: synthetic judge SQL must bind test_work_id in the same statement'],
  );
  assert.deepEqual(
    verifyPhaseEJudgeSource({
      file: 'src/runtime/unbound.ts',
      source:
        'const statement = `DELETE FROM judge_budget_reservations WHERE work_scope = ? AND account_id = ? AND source = ?`;',
    }),
    [
      'src/runtime/unbound.ts: judge work SQL selected by kind, judge, rule, or no selector must bind a literal work_scope with its scope predicates',
      'src/runtime/unbound.ts: judge SQL work_scope must compare with a source-owned or synthetic-test literal',
    ],
  );
  assert.deepEqual(
    verifyPhaseEJudgeSource({
      file: 'src/runtime/unscoped-kind.ts',
      source: 'const statement = `SELECT id FROM judge_budget_reservations WHERE judge_kind = ?`;',
    }),
    [
      'src/runtime/unscoped-kind.ts: judge work SQL selected by kind, judge, rule, or no selector must bind a literal work_scope with its scope predicates',
    ],
  );
  assert.deepEqual(
    verifyPhaseEJudgeSource({
      file: 'src/runtime/primary-key.ts',
      source:
        "const statement = `UPDATE judge_budget_reservations SET state = 'released' WHERE id = ?`;\nconst read = `SELECT id FROM judge_budget_reservations WHERE id = ?`;",
    }),
    [],
    'a single-row primary-key transition is the only unscoped judge-work exemption',
  );
  assert.deepEqual(
    verifyPhaseEJudgeSource({
      file: 'packages/events-daemon/src/runtime/computed-import.ts',
      source: "const name = 'node:https'; const raw = await import(name); raw['request']({});",
    }),
    [
      'packages/events-daemon/src/runtime/computed-import.ts: judge paths must not use computed module specifiers',
      'packages/events-daemon/src/runtime/computed-import.ts: judge paths must not use computed request aliases',
    ],
    'a computed ESM import and request property cannot bypass the raw-network gate',
  );
  assert.deepEqual(
    verifyPhaseEJudgeSource({
      file: 'packages/events-daemon/src/runtime/computed-require.ts',
      source: "const name = 'https'; const raw = require(name); raw.request({});",
    }),
    ['packages/events-daemon/src/runtime/computed-require.ts: judge paths must not use computed module specifiers'],
    'a computed CommonJS import cannot bypass the raw-network gate',
  );
});

test('E12 scope: the audit matrix and explicit Task 10 deferral are structural, not manifest-defined', async () => {
  const root = await manifestFixture();
  try {
    const baselineProblems = await verifyPhaseETestManifest({ root });
    assert.equal(
      baselineProblems.includes('Phase-E audit matrix digest does not match its immutable inventory'),
      false,
      `the immutable audit matrix digest must stay exact: ${baselineProblems.join('; ')}`,
    );
    const verifierPath = join(root, 'scripts/verify-events-phase-e-tests.mjs');
    const verifier = await readFile(verifierPath, 'utf8');
    const pinnedRow = "    ['activation-approval-claim-to-pointer', 'e4-final-pointer-drift'],\n";
    assert.equal(verifier.includes(pinnedRow), true, 'the copied audit matrix contains the pinned await/write row');
    await writeFile(verifierPath, verifier.replace(pinnedRow, ''));
    const copiedVerifier = await import(`${pathToFileURL(verifierPath).href}?matrix-row-deleted=${Date.now()}`);
    const rowProblems = await copiedVerifier.verifyPhaseETestManifest({ root });
    assert.equal(
      rowProblems.includes('Phase-E audit matrix digest does not match its immutable inventory'),
      true,
      `deleting a real audit row must fail the immutable matrix digest: ${rowProblems.join('; ')}`,
    );

    const manifestPath = join(root, 'packages/events-daemon/test/fixtures/judges/case-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    delete manifest.audit;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const problems = await verifyPhaseETestManifest({ root });
    assert.equal(
      problems.includes('Phase-E audit matrix is missing'),
      true,
      `deleting the audit matrix must fail closed: ${problems.join('; ')}`,
    );
    assert.equal(
      problems.includes('Phase-E audit must declare deferred: Task 10'),
      true,
      `Task 10 cannot disappear silently: ${problems.join('; ')}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('E12 scope: judge paths reject alternate HTTP clients and every lifecycle purge caller is structural', async () => {
  assert.deepEqual(
    verifyPhaseEJudgeSource({
      file: 'packages/events-daemon/src/runtime/judge-escape.ts',
      source: 'fetch(url); http.request(url); https.request(url);',
    }),
    [
      'packages/events-daemon/src/runtime/judge-escape.ts: judge paths must not call fetch',
      'packages/events-daemon/src/runtime/judge-escape.ts: judge paths must not call http.request',
      'packages/events-daemon/src/runtime/judge-escape.ts: judge paths must not call https.request',
    ],
    'the raw pinned transport is the only judge network path',
  );
  assert.deepEqual(
    verifyPhaseEJudgeSource({
      file: 'packages/events-daemon/src/runtime/holds.ts',
      source:
        "import { request as raw } from 'https'; import * as httpAlias from 'node:http'; const escaped = fetch; raw(url); httpAlias['request'](url); void escaped;",
    }),
    [
      'packages/events-daemon/src/runtime/holds.ts: judge paths must not reference fetch',
      'packages/events-daemon/src/runtime/holds.ts: judge paths must not import node:http or node:https',
      'packages/events-daemon/src/runtime/holds.ts: judge paths must not use computed request aliases',
    ],
    'judge helper names and raw-client aliases cannot escape the static network boundary',
  );

  const root = await manifestFixture();
  try {
    const targetPath = join(root, 'packages/events-daemon/src/runtime/revocations.ts');
    const targetSource = await readFile(targetPath, 'utf8');
    const targetCall = 'purgeRevokedRuleWork(database.database, rule.rule_id, [rule.version], revokedAt);';
    assert.equal(targetSource.includes(targetCall), true, 'the target-removal fixture contains its judge purge caller');
    await writeFile(targetPath, targetSource.replace(targetCall, 'void rule;'));
    const problems = await verifyPhaseEStaticGuards({ root });
    assert.equal(
      problems.includes('purge caller target-remove is absent from packages/events-daemon/src/runtime/revocations.ts'),
      true,
      `deleting target removal's purge caller must fail closed: ${problems.join('; ')}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
