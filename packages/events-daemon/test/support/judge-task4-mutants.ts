import assert from 'node:assert/strict';
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { copyShippedPackageAssets } from './shipped-assets.ts';
import { runStrictMutationChild } from './strict-mutation-child.ts';

export interface JudgeTask4Mutation {
  readonly id: string;
  readonly source: string;
  readonly test: string;
  readonly testName: string;
  readonly before: string;
  readonly after: string;
  readonly killingAssertion?: string | undefined;
}

/** One destructive edit for each Task-4 authority or closure guard. */
const judgeTask4Mutations: readonly JudgeTask4Mutation[] = [
  {
    id: 'e4-no-pointer-at-prepare',
    source: 'src/runtime/activations.ts',
    test: 'test/judge-budget-activation.test.ts',
    testName:
      'E4 judge-budget activation: an approved immutable singleton is the only path that swaps its exact pointer',
    before: '    const now = this.#now();',
    after:
      "    const now = this.#now();\n    if (document.kind === 'judge-budget') this.#store.database.prepare(\"INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('judge-budget', 'judge-budget', 1, NULL, 0)\").run();",
    killingAssertion: 'the judge activation pointer changed after preparation',
  },
  {
    id: 'e4-final-pointer-drift',
    source: 'src/runtime/activations.ts',
    test: 'test/judge-budget-activation.test.ts',
    testName: 'E4 judge-budget activation: the final write rejects pointer drift after the core claim',
    before: '          this.#assertJudgeActivationLive(document, effect);\n        } catch (_error) {',
    after: '          if (false) this.#assertJudgeActivationLive(document, effect);\n        } catch (_error) {',
  },
  {
    id: 'e4-claim-pointer-drift',
    source: 'src/runtime/activations.ts',
    test: 'test/judge-budget-activation.test.ts',
    testName:
      'E4 judge-budget activation: the local claim transaction rejects post-await pointer drift before finalisation',
    before:
      '          this.#assertJudgeActivationLive(document, JSON.parse(row.effect) as ActivationEffect);\n        } catch (_error) {',
    after:
      '          if (false) this.#assertJudgeActivationLive(document, JSON.parse(row.effect) as ActivationEffect);\n        } catch (_error) {',
  },
  {
    id: 'e4-disabled-judge-add',
    source: 'src/domain/versions.ts',
    test: 'test/judge-kind-enablements.test.ts',
    testName:
      'E4 judge kind: fresh, installed, updated and imported immutable versions leave every kind pointer absent',
    before: '    const document = this.prepareJudge(input);',
    after:
      "    const document = this.prepareJudge(input);\n    if (document.kind === 'typesafe') throw new EventDomainError('JUDGE_KIND_DISABLED', 'mutant refusal');",
    killingAssertion: 'mutant refusal',
  },
  {
    id: 'e4-kind-disable-recovery',
    source: 'src/runtime/judge-kinds.ts',
    test: 'test/judge-purge-closure.test.ts',
    testName:
      'E4 purge closure: kind disable settles in-flight and releases reserved work through the one recovery helper',
    before: '      new JudgePurgeParticipant({ database: this.#store.database, now: this.#now }).kind(enabledKind);',
    after: '      void enabledKind;',
  },
  {
    id: 'e4-laya-before-intent',
    source: 'src/domain/versions.ts',
    test: 'test/judge-budget-activation.test.ts',
    testName:
      'E4 judge kind: TypeSafe enablement has no request, while Laya refuses before an intent or pointer exists',
    before: "if (isJudgeKind(kind) && judgeKindDefinition(kind).availability === 'unavailable')",
    after: "if (false && isJudgeKind(kind) && judgeKindDefinition(kind).availability === 'unavailable')",
  },
  {
    id: 'e4-budget-digest-prepare',
    source: 'src/domain/versions.ts',
    test: 'test/judge-budget-activation.test.ts',
    testName: 'E4 activation digest fence: prepare rejects altered budget and kind version documents',
    before: '    if (sha256Hex(canonicalJson(budget)) !== row.digest)',
    after: '    if (false && sha256Hex(canonicalJson(budget)) !== row.digest)',
  },
  {
    id: 'e4-kind-digest-prepare',
    source: 'src/domain/versions.ts',
    test: 'test/judge-budget-activation.test.ts',
    testName:
      'E4 activation digest fence: the production kind loader rejects a valid altered document with its original digest',
    before: '    if (sha256Hex(canonicalJson(enablement)) !== row.digest)',
    after: '    if (false && sha256Hex(canonicalJson(enablement)) !== row.digest)',
  },
  {
    id: 'e4-budget-digest-claim',
    source: 'src/domain/versions.ts',
    test: 'test/judge-budget-activation.test.ts',
    testName: 'E4 activation digest fence: claim rejects a budget or kind digest changed after approval',
    before: '    if (sha256Hex(canonicalJson(budget)) !== row.digest)',
    after: '    if (false && sha256Hex(canonicalJson(budget)) !== row.digest)',
  },
  {
    id: 'e4-kind-digest-claim',
    source: 'src/domain/versions.ts',
    test: 'test/judge-budget-activation.test.ts',
    testName: 'E4 activation digest fence: claim rejects a budget or kind digest changed after approval',
    before: '    if (sha256Hex(canonicalJson(enablement)) !== row.digest)',
    after: '    if (false && sha256Hex(canonicalJson(enablement)) !== row.digest)',
  },
  {
    id: 'e4-budget-digest-finalise',
    source: 'src/domain/versions.ts',
    test: 'test/judge-budget-activation.test.ts',
    testName: 'E4 activation digest fence: finalise rejects a budget or kind digest changed after claim',
    before: '    if (sha256Hex(canonicalJson(budget)) !== row.digest)',
    after: '    if (false && sha256Hex(canonicalJson(budget)) !== row.digest)',
  },
  {
    id: 'e4-kind-digest-finalise',
    source: 'src/domain/versions.ts',
    test: 'test/judge-budget-activation.test.ts',
    testName: 'E4 activation digest fence: finalise rejects a budget or kind digest changed after claim',
    before: '    if (sha256Hex(canonicalJson(enablement)) !== row.digest)',
    after: '    if (false && sha256Hex(canonicalJson(enablement)) !== row.digest)',
  },
  {
    id: 'e4-budget-digest-live-reservation',
    source: 'src/domain/versions.ts',
    test: 'test/judge-budgets.test.ts',
    testName:
      'E4 budget digest fence: a live reservation refuses an altered active budget before it creates ledger work',
    before: '    if (sha256Hex(canonicalJson(budget)) !== row.digest)',
    after: '    if (false && sha256Hex(canonicalJson(budget)) !== row.digest)',
  },
  {
    id: 'e4-kind-digest-live-reservation',
    source: 'src/runtime/judge-budget.ts',
    test: 'test/judge-budgets.test.ts',
    testName: 'E4 kind digest fence: a live reservation treats an altered active kind document as unavailable',
    before: '    const document = new ImmutableVersions(database).loadJudgeKind(kind, row.version);',
    after: '    const document = { kind, version: row.version };',
  },
  {
    id: 'e4-first-enablement-disable',
    source: 'src/runtime/judge-kinds.ts',
    test: 'test/judge-budget-activation.test.ts',
    testName:
      'E4 judge kind: disable before first enablement cancels the pending activation and reports its absent pointer',
    before:
      '      const pendingActivationsCancelled = this.#activations?.cancelForJudgeKindInTransaction(enabledKind) ?? 0;',
    after: '      const pendingActivationsCancelled = 0;',
  },
  {
    id: 'e4-absent-kind-disable-generation',
    source: 'src/runtime/activations.ts',
    test: 'test/judge-budget-activation.test.ts',
    testName: 'E4 judge kind: an absent-kind disable during prepare refuses before it can install a first pointer',
    before: '      pointer.disableGeneration !== this.#judgeKindDisableGeneration(expectedObjectId)',
    after: '      false && pointer.disableGeneration !== this.#judgeKindDisableGeneration(expectedObjectId)',
  },
  {
    id: 'e4-expiry-rule-version',
    source: 'src/runtime/expiry.ts',
    test: 'test/judge-purge-closure.test.ts',
    testName: 'E4 purge closure: expiry settles only the expired rule on an event shared with live rule B work',
    before: '          ruleId: work.rule_id,\n          ruleVersion: work.rule_version,\n',
    after: '',
  },
  {
    id: 'e4-tightening-rule-version',
    source: 'src/runtime/replacements.ts',
    test: 'test/judge-purge-closure.test.ts',
    testName: 'E4 purge closure: retention tightening settles only rule A on an event shared with live rule B work',
    before: '      ruleVersion: projection.rule_version,\n',
    after: '      ruleVersion: 1,\n',
    killingAssertion: 'retention tightening: rule A version 2 is terminalised',
  },
  {
    id: 'e4-unscoped-kind-static-guard',
    source: 'scripts/verify-events-phase-e-tests.mjs',
    test: 'test/judge-task4-mutations.test.ts',
    testName: 'E4 mutation: verifier static scope and required Task-4 guard rows refuse drift',
    before: '    if (unscopedJudgeWorkSelection(statement)) {',
    after: '    if (false && unscopedJudgeWorkSelection(statement)) {',
  },
  {
    id: 'e4-primary-key-exemption',
    source: 'scripts/verify-events-phase-e-tests.mjs',
    test: 'test/judge-task4-mutations.test.ts',
    testName: 'E4 verifier: the primary-key exemption permits one bound equality and rejects broadening clauses',
    before:
      '    primaryKeyPredicates.length === 1 &&\n    predicates.every((predicate) => primaryKeyEquality.test(predicate) || !primaryKeyMentions.test(predicate))',
    after: '    false',
  },
  {
    id: 'e4-required-guard-rows',
    source: 'scripts/verify-events-phase-e-tests.mjs',
    test: 'test/judge-task4-mutations.test.ts',
    testName: 'E4 mutation: verifier static scope and required Task-4 guard rows refuse drift',
    before: "  'e4-laya-before-intent',\n",
    after: '',
  },
];

export const JUDGE_TASK4_MUTATIONS: readonly (JudgeTask4Mutation & { readonly killingAssertion: string })[] =
  judgeTask4Mutations.map((mutation): JudgeTask4Mutation & { readonly killingAssertion: string } => ({
    ...mutation,
    killingAssertion: mutation.killingAssertion ?? 'ERR_ASSERTION',
  }));

const packageRoot = join(import.meta.dirname, '..', '..');
const repositoryRoot = join(packageRoot, '..', '..');
const mutantsRoot = join(packageRoot, '.mutants');

function exact(name: string): string {
  return `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

async function rewriteImports(root: string): Promise<void> {
  const copiedTests = join(root, 'test');
  const originalTests = join(packageRoot, 'test');
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const copied = join(directory, entry.name);
      if (entry.isDirectory()) await visit(copied);
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        const original = join(originalTests, relative(copiedTests, copied));
        const source = await readFile(copied, 'utf8');
        const rewritten = source.replace(
          /(\b(?:from|import)\s*(?:\()?\s*)(['"])([^'"]+)\2/gu,
          (match, prefix: string, quote: string, specifier: string) => {
            if (!specifier.startsWith('.')) return match;
            const target = resolve(dirname(original), specifier);
            if (!relative(packageRoot, target).startsWith('..')) return match;
            const repositoryRelative = relative(repositoryRoot, target);
            if (!repositoryRelative.startsWith('..')) {
              const copiedTarget = join(root, repositoryRelative);
              let copiedSpecifier = relative(dirname(copied), copiedTarget);
              if (!copiedSpecifier.startsWith('.')) copiedSpecifier = `./${copiedSpecifier}`;
              return `${prefix}${quote}${copiedSpecifier}${quote}`;
            }
            return `${prefix}${quote}${pathToFileURL(target).href}${quote}`;
          },
        );
        if (rewritten !== source) await writeFile(copied, rewritten, 'utf8');
      }
    }
  };
  await visit(copiedTests);
}

function tap(
  result: { readonly code: number | null; readonly output: string },
  mutation: JudgeTask4Mutation,
  baseline: boolean,
): void {
  const value = (name: 'tests' | 'pass' | 'fail') => {
    const matches = [...result.output.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gmu'))];
    assert.equal(matches.length, 1, `${mutation.id}: missing TAP ${name} summary\n${result.output}`);
    return Number(matches[0]?.[1]);
  };
  if (baseline) {
    assert.equal(result.code, 0, `${mutation.id}: named test is not green before mutation\n${result.output}`);
    assert.equal(value('tests'), 1);
    assert.equal(value('pass'), 1);
    assert.equal(value('fail'), 0);
  } else {
    assert.notEqual(result.code, 0, `${mutation.id}: named test accepted its mutant\n${result.output}`);
    assert.equal(value('tests'), 1);
    assert.equal(value('fail'), 1);
    assert.equal(
      result.output.includes(mutation.killingAssertion ?? ''),
      true,
      `${mutation.id}: its named guard assertion did not kill the mutant\n${result.output}`,
    );
  }
}

/** Proves the real named case passes unmutated, then fails exactly once against its copied production mutant. */
export async function expectJudgeTask4MutationToFail(mutation: JudgeTask4Mutation): Promise<void> {
  const root = join(mutantsRoot, mutation.id);
  await rm(root, { recursive: true, force: true });
  try {
    await cp(join(packageRoot, 'src'), join(root, 'src'), { recursive: true });
    await copyShippedPackageAssets(packageRoot, root);
    await cp(join(packageRoot, 'src'), join(root, 'packages', 'events-daemon', 'src'), { recursive: true });
    await cp(join(packageRoot, 'test'), join(root, 'test'), { recursive: true });
    await cp(join(repositoryRoot, 'scripts'), join(root, 'scripts'), { recursive: true });
    // The copied scripts import the canonical judge-kind registry by its repository path.
    await cp(join(packageRoot, 'src'), join(root, 'packages', 'events-daemon', 'src'), { recursive: true });
    await rewriteImports(root);
    const args = [
      '--import',
      pathToFileURL(join(repositoryRoot, 'test/helpers/loopback-seal-preload.mjs')).href,
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      '--test',
      '--test-reporter=tap',
      '--test-name-pattern',
      exact(mutation.testName),
      join(root, mutation.test),
    ];
    const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;
    env.PHASE_E_ORIGINAL_ROOT = repositoryRoot;
    tap(
      await runStrictMutationChild({ command: process.execPath, args, cwd: root, env, timeoutMs: 30_000 }),
      mutation,
      true,
    );
    const target = join(root, mutation.source);
    const source = await readFile(target, 'utf8');
    assert.equal(source.split(mutation.before).length - 1, 1, `${mutation.id}: source guard is not unique`);
    await writeFile(target, source.replace(mutation.before, mutation.after), 'utf8');
    tap(
      await runStrictMutationChild({ command: process.execPath, args, cwd: root, env, timeoutMs: 30_000 }),
      mutation,
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
