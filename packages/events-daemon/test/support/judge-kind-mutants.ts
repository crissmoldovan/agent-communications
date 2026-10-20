import assert from 'node:assert/strict';
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { copyShippedPackageAssets } from './shipped-assets.ts';
import { runStrictMutationChild } from './strict-mutation-child.ts';

export interface JudgeKindMutation {
  readonly id: string;
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly testFile: string;
  readonly testName: string;
  readonly killingAssertion?: string | undefined;
}

/** Each E1 kind fence is removed in one copied production file and killed by its sole real-path oracle. */
const judgeKindMutations: readonly JudgeKindMutation[] = [
  {
    id: 'e1-canonical-documents',
    file: 'domain/judges.ts',
    before:
      "if (judge.provider !== JUDGE_KIND_TYPESAFE) return fail('a typesafe judge names the TypeSafe Jev adapter');",
    after: "if (false) return fail('a typesafe judge names the TypeSafe Jev adapter');",
    testFile: 'judge-documents.test.ts',
    testName: 'E1: judge documents are closed discriminated forms with a concrete local score pointer',
    killingAssertion: 'each malformed judge document is refused by its closed discriminant',
  },
  {
    id: 'e1-prepare-disabled-kind',
    file: 'domain/versions.ts',
    before: `      assertJudgeKindEnabled(
        rule.agentic.judge.kind,
        this.activeVersion('judge-kind', rule.agentic.judge.kind) !== null,
      );`,
    after: '      void rule.agentic;',
    testFile: 'version-lifecycle.test.ts',
    testName: 'E1: only a rule activation that names an agentic judge refuses its disabled kind with the stable code',
  },
  {
    id: 'e1-claim-before-core-disabled-kind',
    file: 'runtime/activations.ts',
    before: 'const finalBinding = this.#liveBinding(finalIntent);',
    after: 'const finalBinding = binding;',
    testFile: 'judge-kind-activation-race.test.ts',
    testName: 'E1 judge-kind claim race: disabling after approval refuses the claim before a baseline or rule pointer',
  },
  {
    id: 'e1-local-claim-transaction-disabled-kind',
    file: 'runtime/activations.ts',
    before: `const document = this.#document(row);
      this.#assertBoundRuleAuthority(document);`,
    after: `const document = this.#document(row);
      void row;`,
    testFile: 'judge-kind-activation-race.test.ts',
    testName:
      'E1 judge-kind claimed race: disabling after the core claim refuses its local claim transaction before a baseline',
  },
  {
    id: 'e1-finalise-transaction-disabled-kind',
    file: 'runtime/activations.ts',
    before: `// Baseline and point encryption have awaited.  Check under the pointer-write transaction, not only when the
      // rule was prepared or approved, so a disabled kind can never become effective through this final swap.
      this.#assertBoundRuleAuthority(document);`,
    after: `// Baseline and point encryption have awaited.  Check under the pointer-write transaction, not only when the
      // rule was prepared or approved, so a disabled kind can never become effective through this final swap.
      void document;`,
    testFile: 'judge-kind-activation-race.test.ts',
    testName: 'E1 judge-kind finalisation race: disabling after claim refuses the final pointer transaction',
  },
];

export const JUDGE_KIND_MUTATIONS: readonly (JudgeKindMutation & { readonly killingAssertion: string })[] =
  judgeKindMutations.map((mutation): JudgeKindMutation & { readonly killingAssertion: string } => ({
    ...mutation,
    killingAssertion: mutation.killingAssertion ?? 'ERR_ASSERTION',
  }));

const packageRoot = join(import.meta.dirname, '..', '..');
const repositoryRoot = join(packageRoot, '..', '..');
const mutantsRoot = join(packageRoot, '.mutants');

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function exactTestName(name: string): string {
  return `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
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
          return `${prefix}${quote}${pathToFileURL(target).href}${quote}`;
        },
      );
      if (rewritten !== source) await writeFile(copied, rewritten, 'utf8');
    }
  };
  await rewrite(copiedTests);
}

function assertExactlyOneNamedMutationFailure(
  mutation: JudgeKindMutation,
  result: { readonly code: number | null; readonly output: string },
): void {
  assert.notEqual(
    result.code,
    0,
    `${mutation.id}: ${mutation.testName} unexpectedly accepted its mutant\n${result.output}`,
  );
  const summary = (name: 'tests' | 'fail'): number => {
    const values = [...result.output.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gmu'))];
    assert.equal(values.length, 1, `${mutation.id}: child emitted no unique TAP ${name} summary\n${result.output}`);
    return Number(values[0]?.[1]);
  };
  assert.equal(summary('tests'), 1, `${mutation.id}: the child ran more than its one named test\n${result.output}`);
  assert.equal(summary('fail'), 1, `${mutation.id}: the named test did not fail\n${result.output}`);
  const subtests = [...result.output.matchAll(/^# Subtest: (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(subtests, [mutation.testName], `${mutation.id}: a different test ran\n${result.output}`);
  const failures = [...result.output.matchAll(/^not ok \d+ - (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(failures, [mutation.testName], `${mutation.id}: its named test did not fail\n${result.output}`);
  assert.equal(
    result.output.includes(mutation.killingAssertion ?? ''),
    true,
    `${mutation.id}: its named guard assertion did not kill the mutant\n${result.output}`,
  );
}

function assertExactlyOneNamedMutationPass(
  mutation: JudgeKindMutation,
  result: { readonly code: number | null; readonly output: string },
): void {
  assert.equal(result.code, 0, `${mutation.id}: unmutated named test did not pass\n${result.output}`);
  const summary = (name: 'tests' | 'pass' | 'fail'): number => {
    const values = [...result.output.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gmu'))];
    assert.equal(values.length, 1, `${mutation.id}: baseline emitted no unique TAP ${name} summary\n${result.output}`);
    return Number(values[0]?.[1]);
  };
  assert.equal(summary('tests'), 1, `${mutation.id}: baseline ran more than one named test\n${result.output}`);
  assert.equal(summary('pass'), 1, `${mutation.id}: baseline did not pass exactly once\n${result.output}`);
  assert.equal(summary('fail'), 0, `${mutation.id}: baseline reported a failure\n${result.output}`);
}

/** Runs one exact test against a one-edit copied production tree and proves its oracle rejects the absent guard. */
export async function expectJudgeKindMutationToFail(mutation: JudgeKindMutation): Promise<number> {
  const root = join(mutantsRoot, mutation.id);
  await rm(root, { recursive: true, force: true });
  try {
    await cp(join(packageRoot, 'src'), join(root, 'src'), { recursive: true });
    await copyShippedPackageAssets(packageRoot, root);
    await cp(join(packageRoot, 'test'), join(root, 'test'), { recursive: true });
    await rewriteCopiedCrossPackageImports(root);
    const target = join(root, 'src', mutation.file);
    const original = await readFile(target, 'utf8');
    assert.equal(
      occurrences(original, mutation.before),
      1,
      `${mutation.id}: guarded production text must match exactly once in ${relative(packageRoot, target)}`,
    );
    const changedLine = original.slice(0, original.indexOf(mutation.before)).split('\n').length;
    const { NODE_TEST_CONTEXT: _parentTestContext, ...environment } = process.env;
    const args = [
      '--import',
      pathToFileURL(join(repositoryRoot, 'test/helpers/loopback-seal-preload.mjs')).href,
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      '--test',
      // The strict kill rule reads TAP's summary; Node 24 defaults to the spec reporter when piped.
      '--test-reporter=tap',
      '--test-name-pattern',
      exactTestName(mutation.testName),
      join(root, 'test', mutation.testFile),
    ];
    const baseline = await runStrictMutationChild({ command: process.execPath, args, cwd: root, env: environment });
    assertExactlyOneNamedMutationPass(mutation, baseline);
    await writeFile(target, original.replace(mutation.before, mutation.after), 'utf8');
    const result = await runStrictMutationChild({ command: process.execPath, args, cwd: root, env: environment });
    assertExactlyOneNamedMutationFailure(mutation, result);
    return changedLine;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
