import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface JudgeKindMutation {
  readonly id: string;
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly testFile: string;
  readonly testName: string;
}

/** Each E1 kind fence is removed in one copied production file and killed by its sole real-path oracle. */
export const JUDGE_KIND_MUTATIONS: readonly JudgeKindMutation[] = [
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
    before: 'const claimedBinding = this.#liveBinding(this.#intent(intent.id));',
    after: 'const claimedBinding = binding;',
    testFile: 'judge-kind-activation-race.test.ts',
    testName: 'E1 judge-kind claim race: disabling after approval refuses the claim before a baseline or rule pointer',
  },
  {
    id: 'e1-local-claim-transaction-disabled-kind',
    file: 'runtime/activations.ts',
    before: 'this.#assertRuleJudgeKindEnabled(this.#document(row));',
    after: 'void row;',
    testFile: 'judge-kind-activation-race.test.ts',
    testName:
      'E1 judge-kind claimed race: disabling after the core claim refuses its local claim transaction before a baseline',
  },
  {
    id: 'e1-finalise-transaction-disabled-kind',
    file: 'runtime/activations.ts',
    before: 'this.#assertRuleJudgeKindEnabled(document);',
    after: 'void document;',
    testFile: 'judge-kind-activation-race.test.ts',
    testName: 'E1 judge-kind finalisation race: disabling after claim refuses the final pointer transaction',
  },
];

const packageRoot = join(import.meta.dirname, '..', '..');
const repositoryRoot = join(packageRoot, '..', '..');
const mutantsRoot = join(packageRoot, '.mutants');

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function exactTestName(name: string): string {
  return `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

/** Runs one exact test against a one-edit copied production tree and proves its oracle rejects the absent guard. */
export async function expectJudgeKindMutationToFail(mutation: JudgeKindMutation): Promise<number> {
  const root = join(mutantsRoot, mutation.id);
  await rm(root, { recursive: true, force: true });
  try {
    await cp(join(packageRoot, 'src'), join(root, 'src'), { recursive: true });
    await cp(join(packageRoot, 'test'), join(root, 'test'), { recursive: true });
    const target = join(root, 'src', mutation.file);
    const original = await readFile(target, 'utf8');
    assert.equal(
      occurrences(original, mutation.before),
      1,
      `${mutation.id}: guarded production text must match exactly once in ${relative(packageRoot, target)}`,
    );
    const changedLine = original.slice(0, original.indexOf(mutation.before)).split('\n').length;
    await writeFile(target, original.replace(mutation.before, mutation.after), 'utf8');
    const { NODE_TEST_CONTEXT: _parentTestContext, ...environment } = process.env;
    const result = await new Promise<{ readonly code: number | null; readonly output: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          join(repositoryRoot, 'test/helpers/loopback-seal-preload.mjs'),
          '--experimental-strip-types',
          '--disable-warning=ExperimentalWarning',
          '--test',
          '--test-name-pattern',
          exactTestName(mutation.testName),
          join(root, 'test', mutation.testFile),
        ],
        { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, output }));
    });
    assert.notEqual(
      result.code,
      0,
      `${mutation.id}: ${mutation.testName} unexpectedly accepted mutant src/${mutation.file}:${changedLine}\n${result.output}`,
    );
    return changedLine;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
