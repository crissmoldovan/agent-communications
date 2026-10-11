import assert from 'node:assert/strict';
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runStrictMutationChild } from './strict-mutation-child.ts';

export interface JudgeTask5Mutation {
  readonly id: string;
  readonly source: string;
  readonly test: string;
  readonly testName: string;
  readonly changes: readonly { readonly before: string; readonly after: string }[];
}

const judgeKindSqlSource =
  'const JUDGE_KIND_SQL_VALUES = JUDGE_KINDS.map((kind) => `' +
  "'$" +
  '{kind.replaceAll("\'", "\'\'")}' +
  "'`).join(', ');";

export const JUDGE_TASK5_MUTATIONS: readonly JudgeTask5Mutation[] = [
  {
    id: 'e5-owner-start-recovery',
    source: 'src/runtime/owner.ts',
    test: 'test/judge-crash-recovery.test.ts',
    testName: 'E5 crash: owner startup does not issue a judge-ledger statement before the B3 gate',
    changes: [
      {
        before: "import { EventExpiry, SourceStageExpiryGroup } from './expiry.ts';",
        after:
          "import { EventExpiry, SourceStageExpiryGroup } from './expiry.ts';\nimport { recoverJudgeWork } from './judge-recovery.ts';",
      },
      {
        before: '    await withEventWriterLease(writerQuiescer, () => expiry.sweepAll());',
        after:
          '    await withEventWriterLease(writerQuiescer, () => expiry.sweepAll());\n    database.immediate(() => recoverJudgeWork({ database: database.database, now: now() }));',
      },
    ],
  },
  {
    id: 'e5-v1-literal-judge-kinds',
    source: 'src/store/schema-v1.ts',
    test: 'test/judge-migrations.test.ts',
    testName: 'E5 schema: every fresh and upgraded judge-kind CHECK admits exactly JUDGE_KINDS',
    changes: [{ before: judgeKindSqlSource, after: "const JUDGE_KIND_SQL_VALUES = \"'typesafe', 'local-endpoint'\";" }],
  },
];

const packageRoot = join(import.meta.dirname, '..', '..');
const repositoryRoot = join(packageRoot, '..', '..');
const mutantsRoot = join(packageRoot, '.mutants');

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function exactTestName(name: string): string {
  return `^${name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`;
}

async function rewriteCopiedCrossPackageImports(root: string): Promise<void> {
  const copiedTests = join(root, 'test');
  const originalTests = join(packageRoot, 'test');
  const rewrite = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const copied = join(directory, entry.name);
      if (entry.isDirectory()) {
        await rewrite(copied);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const original = join(originalTests, relative(copiedTests, copied));
      const source = await readFile(copied, 'utf8');
      const rewritten = source.replace(
        /(\b(?:from|import)\s*(?:\()?\s*)(['"])([^'"]+)\2/gu,
        (match, prefix: string, quote: string, specifier: string) => {
          if (!specifier.startsWith('.')) return match;
          const target = resolve(dirname(original), specifier);
          if (!relative(packageRoot, target).startsWith('..')) return match;
          return prefix + quote + pathToFileURL(target).href + quote;
        },
      );
      if (rewritten !== source) await writeFile(copied, rewritten, 'utf8');
    }
  };
  await rewrite(copiedTests);
}

function assertOneNamedFailure(
  mutation: JudgeTask5Mutation,
  result: { readonly code: number | null; readonly output: string },
): void {
  assert.notEqual(result.code, 0, `${mutation.id}: ${mutation.testName} accepted its mutant\n${result.output}`);
  const summary = (name: 'tests' | 'fail'): number => {
    const values = [...result.output.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gmu'))];
    assert.equal(values.length, 1, `${mutation.id}: child emitted no unique TAP ${name} summary\n${result.output}`);
    return Number(values[0]?.[1]);
  };
  assert.equal(summary('tests'), 1, `${mutation.id}: child ran more than its named test\n${result.output}`);
  assert.equal(summary('fail'), 1, `${mutation.id}: named test did not fail\n${result.output}`);
  assert.deepEqual(
    [...result.output.matchAll(/^# Subtest: (.+)$/gmu)].map((match) => match[1]),
    [mutation.testName],
  );
  assert.deepEqual(
    [...result.output.matchAll(/^not ok \d+ - (.+)$/gmu)].map((match) => match[1]),
    [mutation.testName],
  );
}

/** Applies one Task-5 defect to copied production source and proves its one named regression test kills it. */
export async function expectJudgeTask5MutationToFail(mutation: JudgeTask5Mutation): Promise<void> {
  const root = join(mutantsRoot, mutation.id);
  await rm(root, { recursive: true, force: true });
  try {
    await cp(join(packageRoot, 'src'), join(root, 'src'), { recursive: true });
    await cp(join(packageRoot, 'test'), join(root, 'test'), { recursive: true });
    await rewriteCopiedCrossPackageImports(root);
    const target = join(root, mutation.source);
    let changed = await readFile(target, 'utf8');
    for (const change of mutation.changes) {
      assert.equal(occurrences(changed, change.before), 1, `${mutation.id}: guarded source must match exactly once`);
      changed = changed.replace(change.before, change.after);
    }
    await writeFile(target, changed, 'utf8');
    const { NODE_TEST_CONTEXT: _parentTestContext, ...environment } = process.env;
    const result = await runStrictMutationChild({
      command: process.execPath,
      args: [
        '--import',
        join(repositoryRoot, 'test/helpers/loopback-seal-preload.mjs'),
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        '--test',
        // The strict kill rule reads TAP's summary; Node 24 defaults to the spec reporter when piped.
        '--test-reporter=tap',
        '--test-name-pattern',
        exactTestName(mutation.testName),
        join(root, mutation.test),
      ],
      cwd: root,
      env: environment,
    });
    assertOneNamedFailure(mutation, result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
