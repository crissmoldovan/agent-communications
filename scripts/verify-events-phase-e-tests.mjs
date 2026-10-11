#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'packages/events-daemon/test/fixtures/judges/case-manifest.json';
const GATE_SCRIPTS = ['scripts/verify-events-phase-e-prerequisites.mjs', 'scripts/verify-events-phase-e-tests.mjs'];

/**
 * These are the only strict runners which own Phase-E mutation declarations. A manifest cannot merely name a
 * runner: the verifier below also proves that its mutation id is in that runner's iterated collection.
 */
const STRICT_RUNNERS = Object.freeze({
  'judge-kind-mutants': {
    test: 'packages/events-daemon/test/judge-kind-mutations.test.ts',
    support: 'packages/events-daemon/test/support/judge-kind-mutants.ts',
    collection: 'JUDGE_KIND_MUTATIONS',
    helper: 'expectJudgeKindMutationToFail',
  },
  'judge-budget-mutants': {
    test: 'packages/events-daemon/test/judge-budget-mutations.test.ts',
    support: 'packages/events-daemon/test/support/judge-budget-mutants.ts',
    collection: 'JUDGE_BUDGET_MUTATIONS',
    helper: 'expectJudgeBudgetMutationToFail',
  },
  'judge-task5-mutants': {
    test: 'packages/events-daemon/test/judge-task5-mutations.test.ts',
    support: 'packages/events-daemon/test/support/judge-task5-mutants.ts',
    collection: 'JUDGE_TASK5_MUTATIONS',
    helper: 'expectJudgeTask5MutationToFail',
  },
  'judge-task4-mutants': {
    test: 'packages/events-daemon/test/judge-task4-mutations.test.ts',
    support: 'packages/events-daemon/test/support/judge-task4-mutants.ts',
    collection: 'JUDGE_TASK4_MUTATIONS',
    helper: 'expectJudgeTask4MutationToFail',
  },
  'judge-mutants': {
    test: 'packages/events-daemon/test/judge-mutations.test.ts',
    support: 'packages/events-daemon/test/support/judge-mutants.ts',
    collection: 'PHASE_E_GATE_MUTATIONS',
    helper: 'expectJudgeMutationToFail',
  },
  'judge-transport-mutants': {
    test: 'packages/events-daemon/test/judge-transport.test.ts',
    support: 'packages/events-daemon/test/support/judge-transport-mutants.ts',
    collection: 'JUDGE_TRANSPORT_MUTATION_IDS',
    loopCollection: 'JUDGE_TRANSPORT_MUTATIONS',
    helper: 'expectTransportMutationToFail',
  },
});

/** E owns these rows rather than allowing a mutable manifest to define which completed-task guards matter. */
const REQUIRED_GUARD_ROWS = Object.freeze([
  'task-1-canonical-documents',
  'task-2-durable-schema',
  'phase-e-b3-prerequisite-gate',
  'phase-e-b3-secret-origin',
  'phase-e-b3-pending-target-origin',
  'phase-e-source-scope',
  'phase-e-synthetic-scope',
  'e4-no-pointer-at-prepare',
  'e4-final-pointer-drift',
  'e4-claim-pointer-drift',
  'e4-disabled-judge-add',
  'e4-kind-disable-recovery',
  'e4-laya-before-intent',
  'e4-budget-digest-prepare',
  'e4-kind-digest-prepare',
  'e4-budget-digest-claim',
  'e4-kind-digest-claim',
  'e4-budget-digest-finalise',
  'e4-kind-digest-finalise',
  'e4-budget-digest-live-reservation',
  'e4-kind-digest-live-reservation',
  'e4-first-enablement-disable',
  'e4-absent-kind-disable-generation',
  'e4-expiry-rule-version',
  'e4-tightening-rule-version',
  'e4-unscoped-kind-static-guard',
  'e4-primary-key-exemption',
  'e4-required-guard-rows',
]);

async function source(root, file) {
  return readFile(join(root, file), 'utf8').catch(() => undefined);
}

async function tsFiles(root, directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await tsFiles(root, file)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) {
      const text = await source(root, file);
      if (text !== undefined) files.push({ file, source: text });
    }
  }
  return files;
}

const typesafeKind = 'typesafe';
const layaKind = 'laya';
const localEndpointKind = 'local-endpoint';
const JUDGE_KIND_NAMES = new Set([typesafeKind, layaKind, localEndpointKind]);

function hasAllJudgeKinds(text) {
  return [...JUDGE_KIND_NAMES].every((kind) => new RegExp(`['"]${kind}['"]`, 'u').test(text));
}

function hasClosedKindLiteral(text) {
  const arrays = text.match(/\[[^\]]{0,500}\]/gsu) ?? [];
  if (arrays.some(hasAllJudgeKinds)) return true;
  const objects = text.match(/\{[^{}]{0,500}\}/gsu) ?? [];
  if (
    objects.some((object) =>
      [...JUDGE_KIND_NAMES].every((kind) => new RegExp(`(?:['"]${kind}['"]|${kind})\\s*:`, 'u').test(object)),
    )
  )
    return true;
  const declarations = text.match(/(?:type|interface)\s+[A-Za-z_$][\w$]*(?:\s*<[^>]*>)?\s*=\s*[^;\n]{0,500}/gu) ?? [];
  return declarations.some((declaration) => declaration.includes('|') && hasAllJudgeKinds(declaration));
}

function sqlStatements(text) {
  const strings = [];
  const literal = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/gu;
  for (const match of text.matchAll(literal)) {
    const value = match[2];
    if (!value || !/\b(?:SELECT|UPDATE|DELETE)\b/iu.test(value) || !/\bjudge_[a-z_]+\b/iu.test(value)) continue;
    for (const statement of value.split(';')) {
      if (/\b(?:SELECT\b[\s\S]*?\bFROM|UPDATE|DELETE\s+FROM)\s+judge_[a-z_]+\b/iu.test(statement))
        strings.push(statement);
    }
  }
  return strings;
}

function primaryKeyOnly(statement) {
  const match = /\bWHERE\s+([\s\S]*)$/iu.exec(statement);
  if (match === null) return false;
  const predicates = match[1]
    .trim()
    .split(/\s+AND\s+/iu)
    .map((predicate) => predicate.trim());
  if (predicates.length === 0 || /\bOR\b|\(|\)|\bSELECT\b/iu.test(match[1])) return false;
  const primaryKeyEquality = /^(?:[a-z_]+\.)?id\s*=\s*\?$/iu;
  const primaryKeyMentions = /(?:^|\s|\.)(?:[a-z_]+\.)?id\b/iu;
  const primaryKeyPredicates = predicates.filter((predicate) => primaryKeyEquality.test(predicate));
  return (
    primaryKeyPredicates.length === 1 &&
    predicates.every((predicate) => primaryKeyEquality.test(predicate) || !primaryKeyMentions.test(predicate))
  );
}

function hasJudgeWorkScopeLiteral(statement) {
  return /\bwork_scope\s*=\s*'(?:source-owned|synthetic-test)'/iu.test(statement);
}

/**
 * A reservation transition may address exactly one row by its primary key. Every broader judge-work selection must
 * disclose its closed source/account or synthetic-test scope in that SQL statement, before it can feed a mutation.
 */
function unscopedJudgeWorkSelection(statement) {
  if (!/\bjudge_budget_reservations\b/iu.test(statement) || primaryKeyOnly(statement)) return false;
  if (!/^\s*(?:SELECT|UPDATE|DELETE)\b/iu.test(statement)) return false;
  // Rolling-accounting reads interpolate a closed accounting predicate and cannot feed the recovery/purge transition.
  if (/\$\{where\}/u.test(statement)) return false;
  // A migration copy is neither an UPDATE/DELETE nor a selecting read that feeds one.
  if (/^\s*INSERT\b/iu.test(statement)) return false;
  return !hasJudgeWorkScopeLiteral(statement);
}

function isScopeEnumeration(statement) {
  return (
    /^\s*SELECT\s+DISTINCT\s+work_scope\s*,\s*source\s*,\s*account_id\s*,\s*test_work_id\b/iu.test(statement) &&
    /\bwork_scope\s*=\s*'source-owned'\s+AND\s+source\s+IS\s+NOT\s+NULL\s+AND\s+account_id\s+IS\s+NOT\s+NULL/iu.test(
      statement,
    ) &&
    /\bwork_scope\s*=\s*'synthetic-test'\s+AND\s+test_work_id\s+IS\s+NOT\s+NULL/iu.test(statement)
  );
}

function isSourceScopeEnumeration(statement) {
  return (
    /^\s*SELECT\s+DISTINCT\s+source\s*,\s*account_id\s*,\s*rule_version\b/iu.test(statement) &&
    /\bwork_scope\s*=\s*'source-owned'\s+AND\s+source\s+IS\s+NOT\s+NULL\s+AND\s+account_id\s+IS\s+NOT\s+NULL/iu.test(
      statement,
    )
  );
}

/** Scan one production source file; exported so fixture-copy tests exercise the exact static rules. */
export function verifyPhaseEJudgeSource({ file, source: text }) {
  const problems = [];
  if (file !== 'packages/events-daemon/src/domain/lifecycle.ts' && hasClosedKindLiteral(text)) {
    problems.push(`${file}: judge kind literals must come from domain/lifecycle.ts`);
  }
  for (const statement of sqlStatements(text)) {
    if (unscopedJudgeWorkSelection(statement)) {
      problems.push(
        `${file}: judge work SQL selected by kind, judge, rule, or no selector must bind a literal work_scope with its scope predicates`,
      );
    }
    const scopes = [...statement.matchAll(/\bwork_scope\s*=\s*([^\s)]+)/giu)];
    for (const scope of scopes) {
      const value = scope[1];
      if (value === "'source-owned'") {
        if (
          !isScopeEnumeration(statement) &&
          !isSourceScopeEnumeration(statement) &&
          (!/\baccount_id\s*=\s*\?/iu.test(statement) || !/\bsource\s*=\s*\?/iu.test(statement))
        )
          problems.push(`${file}: source-owned judge SQL must bind account_id and source in the same statement`);
      } else if (value === "'synthetic-test'") {
        if (!isScopeEnumeration(statement) && !/\btest_work_id\s*=\s*\?/iu.test(statement))
          problems.push(`${file}: synthetic judge SQL must bind test_work_id in the same statement`);
      } else {
        problems.push(`${file}: judge SQL work_scope must compare with a source-owned or synthetic-test literal`);
      }
    }
  }
  return problems;
}

/** Covers every daemon TypeScript module plus both executable gates, rather than files whose names happen to say judge. */
export async function verifyPhaseEStaticGuards({ root = ROOT } = {}) {
  const files = await tsFiles(root, 'packages/events-daemon/src');
  for (const file of GATE_SCRIPTS) {
    const text = await source(root, file);
    if (text !== undefined) files.push({ file, source: text });
  }
  return files.flatMap(verifyPhaseEJudgeSource);
}

function importCandidates(file, specifier) {
  const target = normalize(join(dirname(file), specifier));
  return [target, `${target}.ts`, `${target}.mts`, `${target}.mjs`, join(target, 'index.ts')];
}

/** Resolve relative imports recursively, so a named test has to load the actual production entry, not a local model. */
async function importsProduction(root, testFile, productionEntry) {
  const queue = [testFile];
  const seen = new Set();
  const wanted = normalize(productionEntry);
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const text = await source(root, file);
    if (text === undefined) continue;
    for (const match of text.matchAll(/(?:from\s*|import\s*\()['"]([^'"]+)['"]/gu)) {
      const specifier = match[1];
      if (!specifier?.startsWith('.')) continue;
      for (const candidate of importCandidates(file, specifier)) {
        if (normalize(candidate) === wanted) return true;
        if (!seen.has(candidate) && (await source(root, candidate)) !== undefined) queue.push(candidate);
      }
    }
  }
  return false;
}

async function readRunner(root, runnerName, problems) {
  const runner = STRICT_RUNNERS[runnerName];
  if (!runner) return undefined;
  const [runnerTest, support] = await Promise.all([source(root, runner.test), source(root, runner.support)]);
  if (runnerTest === undefined || support === undefined) {
    problems.push(`${runnerName}: strict runner support or test is unreadable`);
    return undefined;
  }
  let module;
  try {
    module = await import(`${pathToFileURL(join(root, runner.support)).href}?phase-e-manifest=${Date.now()}`);
  } catch (error) {
    problems.push(`${runnerName}: cannot import strict runner support: ${String(error)}`);
    return undefined;
  }
  const collection = module[runner.collection];
  if (
    !Array.isArray(collection) ||
    collection.length === 0 ||
    collection.some((entry) => typeof entry?.id !== 'string')
  ) {
    problems.push(`${runnerName}: strict runner collection is empty or malformed`);
    return undefined;
  }
  const loop = new RegExp(
    `for\\s*\\(\\s*const\\s+mutation\\s+of\\s+${runner.loopCollection ?? runner.collection}\\s*\\)\\s*\\{([\\s\\S]*?)\\}`,
    'u',
  ).exec(runnerTest);
  if (!loop || !new RegExp(`\\b${runner.helper}\\s*\\(\\s*mutation\\s*\\)`, 'u').test(loop[1]))
    problems.push(`${runnerName}: mutation loop does not call ${runner.helper} with its loop mutation`);
  return { ids: collection.map((entry) => entry.id), runner };
}

export async function verifyPhaseETestManifest({ root = ROOT, manifest = undefined } = {}) {
  const problems = [];
  let loaded = manifest;
  if (loaded === undefined) {
    const raw = await source(root, MANIFEST);
    if (raw === undefined) {
      problems.push(`missing Phase-E manifest: ${MANIFEST}`);
      loaded = {};
    } else {
      try {
        loaded = JSON.parse(raw);
      } catch {
        problems.push('Phase-E manifest is valid JSON');
        loaded = {};
      }
    }
  }

  const cases = Array.isArray(loaded?.cases) ? loaded.cases : [];
  const guards = Array.isArray(loaded?.guards) ? loaded.guards : [];
  const mutations = Array.isArray(loaded?.mutations) ? loaded.mutations : [];
  if (!cases.length || !guards.length || !mutations.length) {
    problems.push('Phase-E manifest must declare at least one case, guard, and mutation');
  }

  const guardIds = new Set(guards.flatMap((entry) => (typeof entry?.id === 'string' ? [entry.id] : [])));
  const mutationIds = new Set(mutations.flatMap((entry) => (typeof entry?.id === 'string' ? [entry.id] : [])));
  const guardOwners = new Map();
  const mutationOwners = new Map();
  const runnerRows = new Map(Object.keys(STRICT_RUNNERS).map((name) => [name, new Map()]));
  const packageJson = JSON.parse((await source(root, 'packages/events-daemon/package.json')) ?? '{"scripts":{}}');
  const packageTest = String(packageJson?.scripts?.test ?? '');

  for (const entry of cases) {
    const id = typeof entry?.id === 'string' ? entry.id : '<unnamed-case>';
    const coverage = Array.isArray(entry?.coverage) ? entry.coverage.filter((value) => typeof value === 'string') : [];
    if (coverage.length !== 1 || !guardIds.has(coverage[0])) {
      problems.push(`${id}: coverage must name exactly one owned §5/Task guard`);
    } else {
      guardOwners.set(coverage[0], (guardOwners.get(coverage[0]) ?? 0) + 1);
    }

    const mutationId = entry?.mutation?.id;
    if (typeof mutationId !== 'string' || !mutationIds.has(mutationId)) {
      problems.push(`${id}: mutation id is not owned by the manifest`);
    } else {
      mutationOwners.set(mutationId, (mutationOwners.get(mutationId) ?? 0) + 1);
    }

    if (typeof entry?.test !== 'string') problems.push(`${id}: every case must name its test`);
    if (typeof entry?.productionEntry !== 'string') problems.push(`${id}: every case must name its productionEntry`);

    if (typeof entry?.strictRunner !== 'string' || !(entry.strictRunner in STRICT_RUNNERS)) {
      problems.push(`${id}: strict runner is missing or does not execute this case`);
    } else if (typeof mutationId === 'string') {
      runnerRows.get(entry.strictRunner).set(mutationId, id);
    }

    if (typeof entry?.productionEntry === 'string') {
      if (/(?:^|\/)test(?:\/|$)/u.test(entry.productionEntry)) {
        problems.push(`${id}: production entry must not be a test-local implementation substitute`);
      } else if ((await source(root, entry.productionEntry)) === undefined) {
        problems.push(`${id}: production entry does not exist: ${entry.productionEntry}`);
      }
    }

    if (typeof entry?.test === 'string') {
      const namedTest = await source(root, entry.test);
      if (namedTest === undefined) {
        problems.push(`${id}: named production-path test does not exist: ${entry.test}`);
      } else {
        if (typeof entry?.mutation?.test === 'string' && !namedTest.includes(entry.mutation.test)) {
          problems.push(`${id}: mutation test is not named by ${entry.test}`);
        }
        if (
          typeof entry?.productionEntry === 'string' &&
          !(await importsProduction(root, entry.test, entry.productionEntry))
        ) {
          problems.push(`${id}: named test does not import its production entry`);
        }
      }
    }

    if (entry?.network === true && !packageTest.includes('loopback-seal-preload.mjs')) {
      problems.push(`${id}: judge network test requires the loopback-seal preload`);
    }
  }

  for (const [id, count] of guardOwners) {
    if (count !== 1) problems.push(`${id}: guard has ${count} owners`);
  }
  for (const id of guardIds) if (!guardOwners.has(id)) problems.push(`unowned §5 row: ${id}`);
  for (const [id, count] of mutationOwners) {
    if (count !== 1) problems.push(`${id}: mutation has ${count} owners`);
  }
  for (const id of mutationIds) if (!mutationOwners.has(id)) problems.push(`orphan mutation: ${id}`);
  for (const id of REQUIRED_GUARD_ROWS) {
    if (!guardIds.has(id)) problems.push(`required Phase-E guard row is absent: ${id}`);
    else if (!guardOwners.has(id)) problems.push(`unowned §5 row: ${id}`);
  }
  for (const id of Array.isArray(loaded?.requiredCoverage) ? loaded.requiredCoverage : []) {
    if (typeof id === 'string' && !guardOwners.has(id)) problems.push(`unowned §5 row: ${id}`);
  }
  for (const runnerName of Object.keys(STRICT_RUNNERS)) {
    const loadedRunner = await readRunner(root, runnerName, problems);
    if (loadedRunner === undefined) continue;
    const manifestRows = runnerRows.get(runnerName);
    for (const id of loadedRunner.ids) {
      if (!manifestRows.has(id)) problems.push(`${runnerName}: runner mutation has no manifest row: ${id}`);
    }
    for (const id of manifestRows.keys()) {
      if (!loadedRunner.ids.includes(id)) problems.push(`${runnerName}: manifest row mutation is not in runner: ${id}`);
    }
  }

  problems.push(...(await verifyPhaseEStaticGuards({ root })));
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = await verifyPhaseETestManifest();
  if (problems.length) {
    console.error(problems.map((problem) => `- ${problem}`).join('\n'));
    process.exitCode = 1;
  }
}
