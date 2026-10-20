#!/usr/bin/env node
/**
 * The E2 proof ledger is deliberately a directory of task-owned fragments rather
 * than one editable registry. A task can therefore prove its own guard before
 * committing, and cannot silently rewrite a completed task's evidence.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const casesRelative = 'packages/events-daemon/test/fixtures/laya/cases';
const runtimeName = '@agentcomms/events-laya-runtime';
const runtimePackages = ['@receptron/laya', 'onnxruntime-node', '@huggingface/tokenizers'];
const installCommand = ['pnpm', 'install'].join(' ');
/**
 * Where a registered mutation's oracle runs (`test/support/laya-mutants.ts`): node:test and the desktop app's Vitest in
 * `pnpm verify`, the desktop app's Rust unit tests in desktop.yml, which must run this exact command.
 */
const mutationLegs = ['node', 'vitest', 'cargo'];
const cargoLegCommand =
  'node --experimental-strip-types --disable-warning=ExperimentalWarning packages/events-daemon/test/support/run-laya-mutants.ts --leg cargo';
const normalInstall = `${installCommand} --frozen-lockfile --filter '!${runtimeName}'`;

function fail(message) {
  throw new Error(`E2 proof pairing: ${message}`);
}

function readText(root, path) {
  const target = resolve(root, path);
  if (!target.startsWith(`${resolve(root)}${sep}`) && target !== resolve(root))
    fail(`path escapes the repository: ${path}`);
  if (!existsSync(target)) fail(`missing required file ${path}`);
  return readFileSync(target, 'utf8');
}

function readJson(root, path) {
  try {
    return JSON.parse(readText(root, path));
  } catch (error) {
    fail(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function filesBelow(root, path) {
  const directory = resolve(root, path);
  if (!existsSync(directory)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = resolve(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(relative(root, child).split(sep).join('/'));
    }
  };
  visit(directory);
  return files.sort();
}

function requireObject(value, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${what} must be an object`);
  return value;
}

function requireString(value, what) {
  if (typeof value !== 'string' || value.length === 0) fail(`${what} must be a non-empty string`);
  return value;
}

function ownerOf(row, owners, what) {
  const owner = requireString(requireObject(row, what).owner, `${what}.owner`);
  if (!owners.has(owner)) fail(`${what} has no declared owner ${JSON.stringify(owner)}`);
}

function testContainsName(root, testFile, testName) {
  const source = readText(root, testFile);
  return source.includes(`'${testName}'`) || source.includes(`\`${testName}\``) || source.includes(`"${testName}"`);
}

/** A Rust unit test's path, `<module>::tests::<name>`, is a `#[test] fn <name>(` in that module's own file. */
function cargoTestNamed(testFile, source, testName) {
  const path = /^([a-z_][a-z0-9_]*)::tests::([a-z_][a-z0-9_]*)$/.exec(testName);
  if (path === null) return false;
  if (testFile !== `apps/desktop/src-tauri/src/${path[1]}.rs`) return false;
  return new RegExp(`#\\[test\\]\\s*(?:#\\[[^\\]]*\\]\\s*)*fn ${path[2]}\\(`).test(source);
}

function externalSourceBlocked(message) {
  fail(`E2_EXTERNAL_REFERENCE_BLOCKED: ${message}`);
}

function assertExternalSourceImmutable(fragment, immutable) {
  const sri = /^sha(256|512)-([A-Za-z0-9+/]{40,}={0,2})$/.exec(immutable);
  if (sri !== null) {
    const algorithm = sri[1];
    const payload = sri[2];
    const expectedLength = algorithm === '256' ? 32 : 64;
    const decoded = Buffer.from(payload, 'base64');
    if (decoded.length !== expectedLength || decoded.toString('base64') !== payload) {
      externalSourceBlocked(`${fragment.file}.externalSources[] has a mutable revision or digest`);
    }
    return;
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64}|sha(?:256|512):[a-f0-9]{64,128})$/.test(immutable)) {
    externalSourceBlocked(`${fragment.file}.externalSources[] has a mutable revision or digest`);
  }
}

function externalSourceFields(fragment, source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    externalSourceBlocked(`${fragment.file}.externalSources[] must be an object`);
  }
  const fields = {};
  for (const field of ['id', 'url', 'fetchedAt', 'immutable', 'fact', 'reviewer']) {
    const value = source[field];
    if (typeof value !== 'string' || value.length === 0) {
      externalSourceBlocked(`${fragment.file}.externalSources[] omits ${field}`);
    }
    fields[field] = value;
  }
  try {
    if (new URL(fields.url).protocol !== 'https:') {
      externalSourceBlocked(`${fragment.file}.externalSources[] URL must use HTTPS`);
    }
  } catch {
    externalSourceBlocked(`${fragment.file}.externalSources[] URL is invalid`);
  }
  const fetchedAt = Date.parse(fields.fetchedAt);
  if (!Number.isFinite(fetchedAt) || !fields.fetchedAt.endsWith('Z') || fetchedAt > Date.now()) {
    externalSourceBlocked(`${fragment.file}.externalSources[] has no valid UTC fetch date`);
  }
  assertExternalSourceImmutable(fragment, fields.immutable);
  return fields;
}

export function verifyExternalSources(root, fragment) {
  const record = 'docs/superpowers/evidence/2026-10-10-e2-external-sources.md';
  if (!existsSync(resolve(root, record))) {
    externalSourceBlocked(`${fragment.file} requires the coordinator-fetched ${record}`);
  }
  const evidence = readText(root, record);
  for (const source of fragment.externalSources) {
    const fields = externalSourceFields(fragment, source);
    for (const [field, value] of Object.entries(fields)) {
      if (!evidence.includes(value)) {
        externalSourceBlocked(`${record} does not name required ${field} ${JSON.stringify(value)}`);
      }
    }
  }
}

/**
 * E2 review round 1: a frozen fragment's mutant whose anchored line a later fix had to change is superseded, never
 * edited. A later fragment lists `supersedes: [{ task, mutant, replacement, reason }]`: the superseded mutant must be
 * one task `task` registers and its anchor must match nothing any more (a live mutant is never superseded); the
 * replacement must be a production mutant the superseding fragment registers, killed by the same named test in the
 * same file and leg; the reason must be stated; and no mutant may be superseded twice, superseded after it replaced
 * another, or replace one while it is itself superseded (no chain). The runner skips a superseded mutant and runs its
 * replacement (`test/support/laya-mutants.ts`), and a matrix row naming it is satisfied only by that replacement.
 * Returns each superseded mutant's id with its replacement's.
 */
function verifySupersessions(root, fragments) {
  const registered = new Map();
  for (const fragment of fragments)
    for (const mutation of fragment.value.mutations ?? [])
      if (mutation?.kind === 'production' && typeof mutation.id === 'string')
        registered.set(mutation.id, { mutation, task: fragment.task });
  const superseded = new Map();
  const replacements = new Set();
  for (const fragment of fragments) {
    const entries = fragment.value.supersedes;
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) fail(`${fragment.file}.supersedes must be an array`);
    for (const entry of entries) {
      const row = requireObject(entry, `${fragment.file}.supersedes[]`);
      const id = requireString(row.mutant, `${fragment.file}.supersedes[].mutant`);
      const at = `${fragment.file} supersession of ${JSON.stringify(id)}`;
      if (typeof row.reason !== 'string' || row.reason.trim().length === 0) fail(`${at} states no reason`);
      if (typeof row.replacement !== 'string' || row.replacement.length === 0) fail(`${at} names no replacement`);
      if (!Number.isSafeInteger(row.task) || row.task <= 0 || row.task >= fragment.task)
        fail(`${at} must name the earlier task whose fragment registers it`);
      const old = registered.get(id);
      if (old === undefined || old.task !== row.task) fail(`${at}: task-${row.task}.json registers no such mutant`);
      const source = resolve(root, old.mutation.source);
      const sourceText = existsSync(source) ? readFileSync(source, 'utf8') : '';
      if (typeof old.mutation.before === 'string' && sourceText.includes(old.mutation.before))
        fail(`${at}: its anchor still applies, and a live mutant is never superseded`);
      const replacement = registered.get(row.replacement);
      if (replacement === undefined || replacement.task !== fragment.task)
        fail(`${at}: its replacement ${JSON.stringify(row.replacement)} is not a mutant ${fragment.file} registers`);
      if (
        replacement.mutation.testFile !== old.mutation.testFile ||
        replacement.mutation.testName !== old.mutation.testName ||
        (replacement.mutation.leg ?? 'node') !== (old.mutation.leg ?? 'node')
      )
        fail(`${at}: its replacement must be killed by the same named test, ${JSON.stringify(old.mutation.testName)}`);
      if (superseded.has(id) || replacements.has(id) || superseded.has(row.replacement))
        fail(`${at} makes a supersession chain; supersede each frozen mutant once, by a live replacement`);
      superseded.set(id, row.replacement);
      replacements.add(row.replacement);
    }
  }
  for (const replacement of replacements)
    if (superseded.has(replacement))
      fail(`supersession chain: ${JSON.stringify(replacement)} replaces one mutant and is itself superseded`);
  return superseded;
}

function verifyFragment(root, fragment, schema, superseded = new Map()) {
  const value = requireObject(fragment.value, fragment.file);
  if (value.schemaVersion !== schema.schemaVersion) fail(`${fragment.file} has an unsupported schema version`);
  const task = value.task;
  const matched = /^task-([1-9]\d*)\.json$/.exec(fragment.basename);
  if (!matched || task !== Number(matched[1])) fail(`${fragment.file} task does not match its immutable filename`);
  for (const key of schema.required) {
    if (!Object.hasOwn(value, key)) fail(`${fragment.file} omits required ${key}`);
  }
  for (const collection of [
    'owners',
    'section5',
    'traceability',
    'awaits',
    'fixtures',
    'mutations',
    'externalSources',
  ]) {
    if (!Array.isArray(value[collection])) fail(`${fragment.file}.${collection} must be an array`);
  }

  const owners = new Set();
  for (const row of value.owners) {
    const id = requireString(requireObject(row, `${fragment.file}.owners[]`).id, `${fragment.file}.owners[].id`);
    if (owners.has(id)) fail(`${fragment.file} duplicates owner ${JSON.stringify(id)}`);
    owners.add(id);
  }
  if (owners.size === 0) fail(`${fragment.file} has no owner`);

  for (const [field, rows] of [
    ['section5', value.section5],
    ['traceability', value.traceability],
    ['awaits', value.awaits],
    ['fixtures', value.fixtures],
  ]) {
    for (const row of rows) ownerOf(row, owners, `${fragment.file}.${field}[]`);
  }

  for (const row of value.fixtures) {
    const path = requireString(
      requireObject(row, `${fragment.file}.fixtures[]`).path,
      `${fragment.file}.fixtures[].path`,
    );
    if (!/^task-[1-9]\d*(?:[-.][\w-]+)?\.json$/.test(path) && path !== 'schema-v1.json') {
      fail(`${fragment.file} references shared mutable case manifest ${JSON.stringify(path)}`);
    }
  }

  for (const mutation of value.mutations) {
    const row = requireObject(mutation, `${fragment.file}.mutations[]`);
    const id = requireString(row.id, `${fragment.file}.mutations[].id`);
    const owner = typeof row.owner === 'string' ? row.owner : '';
    if (!owners.has(owner)) fail(`${fragment.file} has orphan mutation ${JSON.stringify(id)}`);
    const source = requireString(row.source, `${fragment.file}.mutations[${id}].source`);
    const testFile = requireString(row.testFile, `${fragment.file}.mutations[${id}].testFile`);
    const testName = requireString(row.testName, `${fragment.file}.mutations[${id}].testName`);
    if (row.testPattern !== testName) {
      fail(`${fragment.file} mutation ${JSON.stringify(id)} testPattern must equal its exact test name`);
    }
    const leg = row.leg ?? 'node';
    if (!mutationLegs.includes(leg)) {
      fail(
        `${fragment.file} mutation ${JSON.stringify(id)} names leg ${JSON.stringify(leg)}, which no runner executes`,
      );
    }
    if (leg !== 'node' && !(source.startsWith('apps/desktop/') && testFile.startsWith('apps/desktop/'))) {
      fail(`${fragment.file} mutation ${JSON.stringify(id)}: a ${leg} mutation edits and tests only the desktop app`);
    }
    // A Vitest test is named by its path, each describe title then its own joined by ` > `: each is in the file.
    const named =
      leg === 'cargo'
        ? cargoTestNamed(testFile, readText(root, testFile), testName)
        : leg === 'vitest'
          ? testName.split(' > ').every((title) => testContainsName(root, testFile, title))
          : testContainsName(root, testFile, testName);
    if (!named) {
      fail(`${fragment.file} has orphan mutation ${JSON.stringify(id)}: ${testFile} does not name its oracle`);
    }
    if (row.kind === 'production' && superseded.has(id)) {
      // Its anchor matches nothing any more (verifySupersessions): its replacement is the mutant that runs.
      requireString(row.before, `${fragment.file}.mutations[${id}].before`);
      requireString(row.after, `${fragment.file}.mutations[${id}].after`);
      continue;
    }
    const sourceText = readText(root, source);
    if (row.kind === 'production') {
      const before = requireString(row.before, `${fragment.file}.mutations[${id}].before`);
      requireString(row.after, `${fragment.file}.mutations[${id}].after`);
      const occurrences = sourceText.split(before).length - 1;
      if (occurrences !== 1) fail(`${fragment.file} mutation ${JSON.stringify(id)} must match one production guard`);
    } else if (row.kind !== 'input') {
      fail(`${fragment.file} mutation ${JSON.stringify(id)} must be an input or production mutation`);
    }
  }

  if (fragment.externalSources.length > 0) verifyExternalSources(root, fragment);
}

/** `pnpm verify` builds no Rust: a registered cargo mutation is executed only if desktop.yml runs the cargo leg. */
function verifyMutationLegsRun(root, fragments) {
  const cargo = fragments.some((fragment) =>
    (fragment.value.mutations ?? []).some((mutation) => mutation?.leg === 'cargo'),
  );
  if (!cargo) return;
  const workflow = readText(root, '.github/workflows/desktop.yml');
  if (!workflow.split(/\r?\n/).some((line) => line.trim() === `run: ${cargoLegCommand}`)) {
    fail(`a cargo-leg mutation is registered, so .github/workflows/desktop.yml must run: ${cargoLegCommand}`);
  }
}

function containsForbiddenCaseKey(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenCaseKey);
  if (value === null || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    const normal = key.replaceAll(/[-_]/g, '').toLowerCase();
    if (
      [
        'rawcorpus',
        'message',
        'subject',
        'address',
        'handle',
        'eventid',
        'testlocalledger',
        'modelstate',
        'decisionledger',
      ].includes(normal)
    ) {
      return true;
    }
    if (containsForbiddenCaseKey(child)) return true;
  }
  return false;
}

function taskNumber(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function verifyCaseFiles(root) {
  const cases = filesBelow(root, casesRelative);
  const fragments = [];
  for (const file of cases) {
    const basename = file.slice(file.lastIndexOf('/') + 1);
    const value = readJson(root, file);
    if (containsForbiddenCaseKey(value)) {
      const reason = JSON.stringify(value).includes('testLocalLedger') ? 'test-local ledger' : 'raw corpus field';
      fail(`${file} contains forbidden ${reason}`);
    }
    if (basename === 'schema-v1.json') continue;

    const namedTask = /^task-([1-9]\d*)\.json$/.exec(basename);
    const declaredTask = taskNumber(value?.task);
    if (!namedTask && declaredTask === undefined) {
      fail(`shared mutable case manifest ${file} is forbidden; each task owns task-<n>.json`);
    }

    const task = declaredTask ?? Number(namedTask[1]);
    const directCaseFile = file.slice(0, file.lastIndexOf('/')) === casesRelative;
    if (!directCaseFile) {
      fail(`task fragment must be directly inside the cases directory: ${file}`);
    }
    fragments.push({
      file,
      basename,
      task,
      value,
      externalSources: value?.externalSources,
    });
  }

  const tasks = new Set();
  for (const fragment of fragments) {
    if (tasks.has(fragment.task)) fail(`duplicate task fragment for task ${fragment.task}: ${fragment.file}`);
    tasks.add(fragment.task);
  }
  return fragments;
}

function verifyDaemonBoundary(root) {
  const daemon = readJson(root, 'packages/events-daemon/package.json');
  const dependencies = { ...daemon.dependencies, ...daemon.optionalDependencies, ...daemon.bundledDependencies };
  for (const name of runtimePackages) {
    if (Object.hasOwn(dependencies, name)) fail(`events daemon must not depend on ${name}`);
  }
  const layaRuntime = 'packages/events-daemon/src/runtime/laya';
  for (const file of filesBelow(root, layaRuntime)) {
    const source = readText(root, file);
    if (/["']laya["']/.test(source)) fail(`${file} duplicates the lifecycle judge-kind literal`);
  }
}

/** Test-only worker launch seams must never become a production escape hatch. */
function verifyWorkerTestSeams(root) {
  const sourceRoot = 'packages/events-daemon/src';
  const boundaryProbe = `${sourceRoot}/runtime/laya/worker-boundary-probe.ts`;
  for (const file of filesBelow(root, sourceRoot)) {
    if (!file.endsWith('.ts') || file === boundaryProbe) continue;
    const source = readText(root, file);
    if (
      /\bcreateLayaWorkerBoundaryForTest\b/.test(source) ||
      /\bexport\s+\*\s+from\s*['"][^'"]*worker-boundary-probe(?:\.ts)?['"]/.test(source)
    ) {
      fail(`${file} imports or re-exports the test-only Laya worker boundary entry`);
    }
    if (/\bsandboxExecAvailable\s*\(\s*\{[\s\S]{0,512}?\bspawnSync\s*:/.test(source)) {
      fail(`${file} passes a sandboxExecAvailable spawnSync seam`);
    }
    if (/\bcreateLayaWorkerBoundary(?:ForTest)?\s*\(\s*\{[\s\S]{0,512}?\bspawn\s*:/.test(source)) {
      fail(`${file} passes a Laya worker boundary spawn seam`);
    }
    if (/\bcreateLayaWorkerBoundary(?:ForTest)?\s*\(\s*\{[\s\S]{0,512}?\bstartListeners\s*:/.test(source)) {
      fail(`${file} passes a Laya worker boundary listener seam`);
    }
  }
}

function verifyTestsAreSealed(root) {
  const runner = readText(root, 'packages/events-daemon/test/support/laya-mutants.ts');
  if (!runner.includes("join(root, 'test/helpers/loopback-seal-preload.mjs')")) {
    fail('production-copy mutant runner must preload the loopback seal');
  }
  if (!runner.includes('--test-name-pattern')) fail('production-copy mutant runner must run one exact named test');
  if (!/assert\.notEqual\(\s*result\.code,\s*0/.test(runner)) {
    fail('production-copy mutant runner must fail when a mutant passes');
  }

  for (const file of filesBelow(root, 'packages/events-daemon/test').filter((path) =>
    /\/laya-[^/]+\.test\.ts$/.test(path),
  )) {
    const source = readText(root, file);
    const hosts = [...source.matchAll(/https?:\/\/([^/'"`\s]+)/g)].map((match) => match[1]);
    if (hosts.some((host) => host !== '127.0.0.1' && host !== '[::1]')) fail(`${file} contains external hostname`);
  }
}

function isFrozenReleaseFixture(file) {
  return /^packages\/[^/]+\/test\/fixtures\/released-[^/]+\//.test(file);
}

function isDatedDesignRecord(file) {
  return /^docs\/superpowers\/(?:plans|specs)\/\d{4}-\d{2}-\d{2}-[^/]+\.md$/.test(file);
}

function trackedTextFiles(root) {
  const files = gitText(root, ['ls-files', '-z'], 'cannot enumerate tracked repository files')
    .split('\0')
    .filter(Boolean)
    .filter((file) => !isFrozenReleaseFixture(file) && file !== 'CHANGELOG.md' && !isDatedDesignRecord(file));
  return files.filter((file) => !readFileSync(resolve(root, file)).includes(0));
}

function logicalCommandLines(source) {
  const commands = [];
  let text = '';
  let line = 1;
  let firstLine = 1;
  for (const sourceLine of source.split(/\r?\n/)) {
    const continued = /\\\s*$/.test(sourceLine);
    if (text.length === 0) firstLine = line;
    text += `${text.length === 0 ? '' : ' '}${continued ? sourceLine.replace(/\\\s*$/, '') : sourceLine}`;
    if (!continued) {
      commands.push({ line: firstLine, text });
      text = '';
    }
    line += 1;
  }
  if (text.length > 0) commands.push({ line: firstLine, text });
  return commands;
}

function commandWords(source) {
  return source
    .replaceAll(/[`'"“”]/g, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^[([{]+|[)\]},.]+$/g, ''))
    .filter(Boolean);
}

function isPnpmInstallCommand(command, pnpmEnd) {
  const end = command.search(/(?:&&|\|\||;)/);
  const words = commandWords(command.slice(pnpmEnd, end === -1 ? undefined : end));
  let options = 0;
  let bareWords = 0;
  for (const word of words) {
    if (word === 'install' || word === 'i') return bareWords <= options;
    if (word.startsWith('-')) options += 1;
    else bareWords += 1;
  }
  return false;
}

function installCommandsBelow(root) {
  const commands = [];
  for (const file of trackedTextFiles(root)) {
    const source = readText(root, file);
    for (const logicalCommand of logicalCommandLines(source)) {
      const pattern = /\bpnpm(?:@[A-Za-z0-9._+-]+)?\b/g;
      for (const match of logicalCommand.text.matchAll(pattern)) {
        const index = match.index ?? 0;
        if (!/\s/.test(logicalCommand.text[index + match[0].length] ?? '')) continue;
        if (!isPnpmInstallCommand(logicalCommand.text.slice(index), match[0].length)) continue;
        commands.push({ file, line: logicalCommand.line, text: logicalCommand.text.slice(index) });
      }
    }
  }
  return commands;
}

function hasRuntimeExclusion(command) {
  return new RegExp(`--filter(?:\\s+|=)[\\s'"\\x60]*!${runtimeName.replace('/', '\\/')}(?=\\s|['"\\x60]|$)`).test(
    command,
  );
}

function verifyAllInstallCommands(root) {
  for (const command of installCommandsBelow(root)) {
    if (!hasRuntimeExclusion(command.text)) {
      fail(`${command.file}:${command.line} ${installCommand} must exclude ${runtimeName}`);
    }
  }
}

function verifyInstallFence(root) {
  verifyAllInstallCommands(root);
  const workflowInstalls = installCommandsBelow(root).filter(
    (command) => command.file === '.github/workflows/release.yml',
  );
  if (workflowInstalls.length === 0 || workflowInstalls.some((command) => command.text.trim() !== normalInstall)) {
    fail(`ordinary CI install must be exactly ${normalInstall}`);
  }
  const packageJson = readJson(root, 'package.json');
  if (packageJson.scripts?.['verify:events-phase-e2'] !== 'node scripts/verify-events-phase-e2-tests.mjs') {
    fail('root package must expose the completed E2 structural checker');
  }
  if (packageJson.scripts?.['verify:laya-ci-install'] !== 'node scripts/verify-laya-ci-install.mjs --self-test') {
    fail('root package must self-test the cold-store install fence without a network install');
  }
  if (!String(packageJson.scripts?.verify ?? '').includes('verify:events-phase-e2')) {
    fail('pnpm verify must run the E2 structural checker');
  }
  if (!String(packageJson.scripts?.verify ?? '').includes('verify:laya-ci-install')) {
    fail('pnpm verify must self-test the cold-store install fence');
  }

  const coldStore = readText(root, 'scripts/verify-laya-ci-install.mjs');
  if (!coldStore.includes('mkdtemp') || !coldStore.includes('--store-dir')) {
    fail('cold-store checker must create and use a fresh pnpm store');
  }
  if ((coldStore.match(/assertNoRuntimeClosure\(store\);/g) ?? []).length !== 2) {
    fail('cold-store checker must prove the runtime closure is absent');
  }
}

function gitText(root, args, purpose) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    fail(`${purpose}; fetch full history and retry`);
  }
}

function historicalTaskFragments(root) {
  const files = gitText(
    root,
    ['log', '--format=', '--name-only', '--diff-filter=A', '--', casesRelative],
    'cannot inspect immutable task fragment history',
  )
    .split('\n')
    .filter((file) => new RegExp(`^${casesRelative}/(?:.+/)?task-[1-9]\\d*\\.json$`).test(file));
  if (
    files.length > 0 &&
    gitText(root, ['rev-parse', '--is-shallow-repository'], 'cannot inspect Git history').trim() === 'true'
  ) {
    fail('cannot verify immutable task fragments in a shallow clone; fetch full history and retry');
  }
  return [...new Set(files)].sort();
}

function verifyImmutableFragments(root) {
  for (const file of historicalTaskFragments(root)) {
    if (!existsSync(resolve(root, file))) fail(`deleted immutable task fragment: ${file}`);
    if (file.slice(0, file.lastIndexOf('/')) !== casesRelative) {
      fail(`task fragment must be directly inside the cases directory: ${file}`);
    }
    const additions = gitText(
      root,
      ['log', '--format=%H', '--diff-filter=A', '--', file],
      `cannot find the first-added commit for immutable task fragment ${file}`,
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    const firstAdded = additions.at(-1);
    if (!firstAdded) {
      fail(`cannot find the first-added commit for immutable task fragment ${file}; fetch full history and retry`);
    }
    const baseline = gitText(
      root,
      ['show', `${firstAdded}:${file}`],
      `cannot read the first-added commit for immutable task fragment ${file}`,
    );
    if (!Buffer.from(baseline).equals(readFileSync(resolve(root, file)))) {
      fail(`immutable task fragment differs from its first-added commit: ${file}; create your task-<n>.json instead`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ E2 Task 12

/** Fragments from this task on may carry `matrix` and `asyncLedger`; Tasks 1–11 were frozen before the matrix. */
const MATRIX_FROM_TASK = 12;
const PLAN = 'docs/superpowers/plans/2026-10-10-events-phase-e2.md';
/** The plan's four proof tables, each found by its heading and read row by row (E2 Task 12, Step 1). */
const PLAN_TABLES = [
  { category: 'plan-section5', heading: '## §5 coverage ownership', taskColumn: 1 },
  { category: 'plan-traceability', heading: '## Spec traceability', taskColumn: 2 },
  { category: 'plan-await', heading: '### Write after await: E2 ledger and mutation proof', taskColumn: null },
  { category: 'plan-decision', heading: '### Decision-to-task audit', taskColumn: 1 },
];
const LAYA_SOURCE = 'packages/events-daemon/src/runtime/laya';
/** The fixed identity and install rules of the plan's "Identity and scope" and cold-store fence, each a matrix row. */
const IDENTITY_RULES = [
  'worker-frame-closed',
  'model-state-content-free',
  'runtime-tree-by-lock-digest',
  'model-tree-by-manifest-id',
  'purge-by-stable-ids',
  'laya-sql-no-raw-identity',
];
/** The structural checks that predate Task 12's matrix (Tasks 3 and 7), each a matrix row with its own red mutant. */
const LEGACY_STATIC_RULES = [
  'daemon-laya-dependency',
  'kind-vocabulary-owned',
  'test-only-worker-seams',
  'mutant-runner-sealed',
  'laya-tests-no-external-host',
  'cases-no-raw-corpus',
];
const INSTALL_RULES = [
  'every-install-excludes-runtime',
  'release-ci-install-exact',
  'cold-store-proves-absence',
  'verify-runs-checker-and-fence',
];

function codeOnly(source) {
  // Block and line comments removed, string contents kept: a rule is about what the code does, not what it says.
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

function gitListed(root) {
  return gitText(
    root,
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    'cannot enumerate the repository files',
  )
    .split('\n')
    .filter((file) => file.length > 0 && existsSync(resolve(root, file)));
}

/** Every declared test name, by the files that declare it: `test(`/`it(` titles, and Rust `module::tests::name`. */
function declaredTests(root) {
  const declared = new Map();
  const add = (name, file) => declared.set(name, [...(declared.get(name) ?? []), file]);
  for (const file of gitListed(root)) {
    if (isFrozenReleaseFixture(file)) continue;
    if (/\.test\.(?:ts|tsx|mjs)$/.test(file)) {
      const source = readFileSync(resolve(root, file), 'utf8');
      for (const match of source.matchAll(/(?:^|[\s;(])(?:test|it)\(\s*(['"`])((?:(?!\1)[^\\]|\\.)+)\1/gm))
        add(match[2], file);
    } else if (/^apps\/desktop\/src-tauri\/src\/[a-z_][a-z0-9_]*\.rs$/.test(file)) {
      const module = file.slice('apps/desktop/src-tauri/src/'.length, -'.rs'.length);
      const source = readFileSync(resolve(root, file), 'utf8');
      for (const match of source.matchAll(/#\[test\]\s*(?:#\[[^\]]*\]\s*)*fn ([a-z_][a-z0-9_]*)\(/g))
        add(`${module}::tests::${match[1]}`, file);
    }
  }
  return declared;
}

function taskNumbersIn(cell) {
  const numbers = new Set();
  for (const match of cell.matchAll(/(\d+)\s*[–-]\s*(\d+)|(\d+)/g)) {
    if (match[3] !== undefined) numbers.add(Number(match[3]));
    else for (let n = Number(match[1]); n <= Number(match[2]); n += 1) numbers.add(n);
  }
  return [...numbers];
}

/** One plan table's rows: the first cell (the row's key) and the tasks its task column names. */
function planTableRows(root, table) {
  const lines = readText(root, PLAN).split('\n');
  const start = lines.findIndex((line) => line.trim() === table.heading);
  if (start === -1) fail(`${PLAN} has no "${table.heading}" table`);
  const rows = [];
  let seenTable = false;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3} /.test(line)) break;
    if (!line.startsWith('|')) {
      if (seenTable) break;
      continue;
    }
    seenTable = true;
    const cells = line
      .slice(1, line.trimEnd().endsWith('|') ? line.trimEnd().length - 1 : undefined)
      .split('|')
      .map((cell) => cell.trim());
    if (
      /^:?-{3,}/.test(cells[0] ?? '') ||
      (rows.length === 0 && /^(?:§5 row|Spec section|Await or|Plan decision)/.test(cells[0] ?? ''))
    )
      continue;
    rows.push({
      key: cells[0],
      tasks: table.taskColumn === null ? null : taskNumbersIn(cells[table.taskColumn] ?? ''),
    });
  }
  if (rows.length === 0) fail(`${PLAN}'s "${table.heading}" table has no rows`);
  return rows;
}

function quotedList(root, file, pattern, what) {
  const match = pattern.exec(readText(root, file));
  if (match === null) fail(`${file} no longer declares ${what}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
}

/** The keys of one exported interface's body, nested `Readonly<{ … }>` members joined by a dot. */
function interfaceKeys(root, file, name) {
  const source = readText(root, file);
  const start = source.indexOf(`export interface ${name} {`);
  if (start === -1) fail(`${file} no longer declares ${name}`);
  const keys = [];
  const stack = [];
  for (const line of source.slice(start).split('\n').slice(1)) {
    const closing = /^\s*\}>?;?\s*$/.test(line) || /^\s*\}>;?\s*$/.test(line);
    if (closing) {
      if (stack.length === 0) break;
      stack.pop();
      continue;
    }
    const member = /^\s*readonly (\w+)\??:/.exec(line);
    if (member === null) continue;
    if (/Readonly<\{\s*$/.test(line)) stack.push(member[1]);
    else keys.push([...stack, member[1]].join('.'));
  }
  return keys;
}

/** Every site that reaches E's one judge purge participant: `<file>#<method>`. */
function purgeCallerSites(root) {
  const sites = new Set();
  for (const file of filesBelow(root, 'packages/events-daemon/src')) {
    if (!file.endsWith('.ts') || file.endsWith('/runtime/judge-purge.ts')) continue;
    const source = codeOnly(readText(root, file));
    const name = file.slice(file.lastIndexOf('/') + 1);
    for (const match of source.matchAll(/new JudgePurgeParticipant\(/g)) {
      // The constructor's argument holds its own parentheses (`now: () => now`): skip to its balanced end.
      let depth = 1;
      let at = (match.index ?? 0) + match[0].length;
      while (at < source.length && depth > 0) {
        if (source[at] === '(') depth += 1;
        else if (source[at] === ')') depth -= 1;
        at += 1;
      }
      const call = /^\s*\.\s*(\w+)\(/.exec(source.slice(at));
      if (call !== null) sites.add(`${name}#${call[1]}`);
    }
    for (const match of source.matchAll(/const (\w+) = new JudgePurgeParticipant\(/g))
      for (const call of source.matchAll(new RegExp(`\\b${match[1]}\\.(\\w+)\\(`, 'g')))
        sites.add(`${name}#${call[1]}`);
  }
  if (sites.size === 0) fail('no E purge caller reaches the judge purge participant');
  return [...sites].sort();
}

/** The fields a quality report must share with its candidate: every `candidate.<field>` the validator compares. */
function candidateBindingFields(root) {
  const source = readText(root, 'scripts/verify-laya-quality-gate.mjs');
  const start = source.indexOf('    const bound =');
  if (start === -1) fail('scripts/verify-laya-quality-gate.mjs no longer binds a report to its candidate');
  const end = source.indexOf('checkTemplates(entry.templates, candidate', start);
  if (end === -1) fail('scripts/verify-laya-quality-gate.mjs no longer binds the templates to the candidate');
  const fields = new Set([...source.slice(start, end).matchAll(/candidate\.([\w.]+)/g)].map((match) => match[1]));
  fields.add('templates');
  return [...fields].sort();
}

/** Every row the matrix must cover, by key, with the owners it may name and the test it must name (if fixed). */
function matrixRows(root, fragments, declared) {
  const rows = new Map();
  const owners = new Set(fragments.flatMap((fragment) => (fragment.value.owners ?? []).map((owner) => owner.id)));
  const anyOwner = [...owners];
  const add = (key, row) => {
    if (rows.has(key)) fail(`two rows share the matrix key ${JSON.stringify(key)}`);
    rows.set(key, row);
  };
  for (const fragment of fragments) {
    for (const field of ['section5', 'traceability', 'awaits']) {
      for (const row of fragment.value[field] ?? []) {
        add(`${field}/task-${fragment.task}/${row.id}`, { owners: [row.owner], test: row.test, fragmentRow: true });
      }
    }
    for (const row of fragment.value.fixtures ?? []) add(`fixture/${row.path}`, { owners: [row.owner], test: null });
  }
  const sources = new Map();
  for (const fragment of fragments)
    for (const source of fragment.value.externalSources ?? []) {
      if (typeof source?.id !== 'string') continue;
      sources.set(source.id, [...(sources.get(source.id) ?? []), `task-${fragment.task}`]);
    }
  for (const [id, declaredBy] of sources) add(`external-source/${id}`, { owners: declaredBy, test: null });
  for (const table of PLAN_TABLES) {
    for (const row of planTableRows(root, table)) {
      const built =
        row.tasks === null ? anyOwner : row.tasks.map((task) => `task-${task}`).filter((id) => owners.has(id));
      // A row whose tasks have no fragment yet is not built; it joins the matrix when its task's fragment lands.
      if (built.length === 0) continue;
      add(`${table.category}/${row.key}`, { owners: built, test: null });
    }
  }
  for (const site of purgeCallerSites(root)) add(`purge-caller/${site}`, { owners: anyOwner, test: null });
  for (const attempt of quotedList(
    root,
    `${LAYA_SOURCE}/worker-boundary-probe.ts`,
    /export const PROBE_ATTEMPTS = \[([^\]]*)\]/,
    'the four boundary attempts',
  ))
    add(`boundary-attempt/${attempt}`, { owners: anyOwner, test: null });
  for (const check of quotedList(
    root,
    'scripts/verify-laya-boundary-gate.mjs',
    /export const BOUNDARY_CHECKS = Object\.freeze\(\[([^\]]*)\]/,
    'the real-Mac boundary checks',
  ))
    add(`real-mac-check/${check}`, { owners: anyOwner, test: null });
  for (const field of interfaceKeys(root, `${LAYA_SOURCE}/contracts.ts`, 'LayaArtifactDoctor'))
    add(`doctor-field/${field}`, { owners: anyOwner, test: null });
  for (const field of interfaceKeys(root, `${LAYA_SOURCE}/contracts.ts`, 'CanonicalLayaEnablementDisclosures'))
    add(`preview-field/${field}`, { owners: anyOwner, test: null });
  for (const field of candidateBindingFields(root)) add(`candidate-binding/${field}`, { owners: anyOwner, test: null });
  for (const rule of IDENTITY_RULES) add(`identity/${rule}`, { owners: anyOwner, test: null });
  for (const rule of INSTALL_RULES) add(`install/${rule}`, { owners: anyOwner, test: null });
  for (const rule of STATIC_RULES) add(`static/${rule.id}`, { owners: anyOwner, test: null });
  for (const rule of LEGACY_STATIC_RULES) add(`static/${rule}`, { owners: anyOwner, test: null });
  void declared;
  return rows;
}

function verifyMatrix(root, fragments, superseded = new Map()) {
  const declared = declaredTests(root);
  const rows = matrixRows(root, fragments, declared);
  const mutations = new Map();
  for (const fragment of fragments)
    for (const mutation of fragment.value.mutations ?? [])
      if (mutation?.kind === 'production' && typeof mutation.id === 'string') {
        if (mutations.has(mutation.id)) fail(`two fragments register mutation ${JSON.stringify(mutation.id)}`);
        mutations.set(mutation.id, mutation);
      }
  const entries = new Map();
  for (const fragment of fragments) {
    const matrix = fragment.value.matrix;
    if (matrix === undefined) continue;
    if (fragment.task < MATRIX_FROM_TASK) fail(`${fragment.file} predates the matrix and may not carry one`);
    if (!Array.isArray(matrix)) fail(`${fragment.file}.matrix must be an array`);
    for (const entry of matrix) {
      const at = `${fragment.file}.matrix[${JSON.stringify(entry?.row)}]`;
      requireObject(entry, at);
      const key = requireString(entry.row, `${at}.row`);
      entries.set(key, [...(entries.get(key) ?? []), { ...entry, at }]);
    }
  }
  for (const key of entries.keys())
    if (!rows.has(key)) fail(`matrix entry ${JSON.stringify(key)} names no row this repository has`);
  for (const [key, row] of rows) {
    const found = entries.get(key) ?? [];
    if (found.length === 0) fail(`matrix row ${JSON.stringify(key)} has no owner and red mutant`);
    if (found.length > 1) fail(`matrix row ${JSON.stringify(key)} has ${found.length} entries; exactly one owns it`);
    const [entry] = found;
    const owner = requireString(entry.owner, `${entry.at}.owner`);
    if (!row.owners.includes(owner))
      fail(`${entry.at} names owner ${JSON.stringify(owner)}; this row's owner is one of ${row.owners.join(', ')}`);
    if (!Array.isArray(entry.mutation) && typeof entry.mutation !== 'string') fail(`${entry.at} names no red mutant`);
    if (Array.isArray(entry.mutation)) fail(`${entry.at} names ${entry.mutation.length} red mutants; exactly one`);
    const test = requireString(entry.test, `${entry.at}.test`);
    if ((declared.get(test) ?? []).length !== 1)
      fail(
        `${entry.at} names test ${JSON.stringify(test)}, which ${(declared.get(test) ?? []).length === 0 ? 'no file declares' : 'several files declare'}`,
      );
    if (row.test !== null && row.test !== undefined && test !== row.test) {
      // A frozen row may name a test its own commit never declared; the correction must say so, and is accepted only
      // while no file declares that name.
      if (entry.staleRowTest !== true || (declared.get(row.test) ?? []).length > 0)
        fail(`${entry.at} names ${JSON.stringify(test)}, but its row names ${JSON.stringify(row.test)}`);
    } else if (entry.staleRowTest !== undefined) fail(`${entry.at} marks a row test stale that is not`);
    // A superseded mutant no longer runs: the row it guarded is satisfied only by its replacement, which
    // verifySupersessions proved is killed by the same named test.
    const mutation = mutations.get(superseded.get(entry.mutation) ?? entry.mutation);
    if (mutation === undefined)
      fail(`${entry.at} names mutation ${JSON.stringify(entry.mutation)}, which no fragment registers`);
    if (mutation.testName !== test)
      fail(
        `${entry.at}: mutation ${JSON.stringify(entry.mutation)} is killed by ${JSON.stringify(mutation.testName)}, not ${JSON.stringify(test)}`,
      );
  }
}

/** Every async function or method in the Laya artifact and worker modules: `<file>#<name>`, with its count. */
function lagAsyncFunctions(root) {
  const found = new Map();
  for (const file of filesBelow(root, LAYA_SOURCE)) {
    if (!file.endsWith('.ts')) continue;
    const source = codeOnly(readText(root, file));
    const name = file.slice(file.lastIndexOf('/') + 1);
    for (const match of source.matchAll(
      /\basync\s+(?:function\s*\*?\s*([#\w$]+)|\*?\s*(?:(?:static|override|public|private|protected)\s+)*([#\w$]+)\s*(?:<[^>()]*>)?\s*\()/g,
    )) {
      const fn = match[1] ?? match[2];
      if (fn === undefined || fn === 'function') continue;
      const key = `${name}#${fn}`;
      found.set(key, (found.get(key) ?? 0) + 1);
    }
  }
  return found;
}

function verifyAsyncLedger(root, fragments) {
  const functions = lagAsyncFunctions(root);
  const awaitRows = new Set();
  for (const fragment of fragments)
    for (const row of fragment.value.awaits ?? []) awaitRows.add(`awaits/task-${fragment.task}/${row.id}`);
  for (const row of planTableRows(root, PLAN_TABLES[2])) awaitRows.add(`plan-await/${row.key}`);
  const ledger = new Map();
  for (const fragment of fragments) {
    const entries = fragment.value.asyncLedger;
    if (entries === undefined) continue;
    if (fragment.task < MATRIX_FROM_TASK) fail(`${fragment.file} predates the async ledger and may not carry one`);
    if (!Array.isArray(entries)) fail(`${fragment.file}.asyncLedger must be an array`);
    for (const entry of entries) {
      const key = requireString(
        requireObject(entry, `${fragment.file}.asyncLedger[]`).function,
        `${fragment.file}.asyncLedger[].function`,
      );
      if (ledger.has(key)) fail(`async function ${key} has two ledger entries`);
      ledger.set(key, { ...entry, at: `${fragment.file}.asyncLedger[${JSON.stringify(key)}]` });
    }
  }
  for (const [key, count] of functions) {
    const entry = ledger.get(key);
    if (entry === undefined) fail(`async Laya function ${key} is not in the E2 await ledger`);
    if (entry.occurrences !== count)
      fail(`${entry.at} counts ${entry.occurrences} async ${key}; the source has ${count}: review the new one`);
    if (entry.writes === false) {
      requireString(entry.why, `${entry.at}.why`);
      if (entry.fence !== undefined) fail(`${entry.at} both writes nothing and names a fence`);
    } else {
      const fence = requireString(entry.fence, `${entry.at}.fence`);
      if (!awaitRows.has(fence)) fail(`${entry.at} names fence ${JSON.stringify(fence)}, which is no await row`);
    }
  }
  for (const key of ledger.keys())
    if (!functions.has(key)) fail(`the E2 await ledger names ${key}, which is no async Laya function`);
}

/** Network built-ins a Laya module may import as values: the boundary probe's two, and nowhere else. */
const NETWORK_BUILTINS = /^node:(?:net|dgram|http|https|http2|tls|dns|dns\/promises)$/;

function valueImports(source) {
  const imports = [];
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+(type\s+)?([^'"]*?)\s*from\s*(['"])([^'"]+)\3/g))
    if (match[1] === undefined) imports.push(match[4]);
  for (const match of source.matchAll(/(?:^|\n)\s*import\s*(['"])([^'"]+)\1/g)) imports.push(match[2]);
  for (const match of source.matchAll(/\bimport\(\s*(['"])([^'"]+)\1\s*\)/g)) imports.push(match[2]);
  for (const match of source.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)) imports.push(match[2]);
  return imports;
}

function layaSources(root) {
  return filesBelow(root, LAYA_SOURCE).filter((file) => file.endsWith('.ts'));
}

const LAYA_RUNTIME_ROOTS = [runtimeName, ...runtimePackages];

/**
 * The module specifiers a file's code imports or requires — `import … from`, `export … from`, a bare `import`,
 * `import(…)` and `require(…)` — read past comments and string contents, so text that only mentions a package (a
 * test's refusal data, a script's lock data) is not an import of it.
 */
function codeImportSpecifiers(source) {
  const specifiers = [];
  const identifier = /[\w$]/;
  const skipString = (from) => {
    const quote = source[from];
    let at = from + 1;
    while (at < source.length && source[at] !== quote) at += source[at] === '\\' ? 2 : 1;
    return at + 1;
  };
  let at = 0;
  while (at < source.length) {
    const char = source[at];
    if (char === '/' && source[at + 1] === '/') {
      const end = source.indexOf('\n', at);
      at = end === -1 ? source.length : end;
    } else if (char === '/' && source[at + 1] === '*') {
      const end = source.indexOf('*/', at + 2);
      at = end === -1 ? source.length : end + 2;
    } else if (char === "'" || char === '"' || char === '`') {
      at = skipString(at);
    } else if (identifier.test(char) && (at === 0 || !identifier.test(source[at - 1]))) {
      const word = /^[\w$]+/.exec(source.slice(at, at + 32))[0];
      if ((word === 'import' || word === 'require' || word === 'from') && source[at - 1] !== '.') {
        let next = at + word.length;
        while (/\s/.test(source[next] ?? '')) next += 1;
        if (word !== 'from' && source[next] === '(') {
          next += 1;
          while (/\s/.test(source[next] ?? '')) next += 1;
        }
        const quote = source[next];
        if (quote === "'" || quote === '"') {
          const end = source.indexOf(quote, next + 1);
          if (end !== -1) specifiers.push(source.slice(next + 1, end));
        }
      }
      at += word.length;
    } else at += 1;
  }
  return specifiers;
}

/**
 * E2 review round 1 (A1): the boundary probe's file starts a process in exactly two places — the launcher's
 * `sandbox-exec`, and the worker's fifth attempt, which the profile must refuse — and in no other way: no second call,
 * no other `child_process` entry point, no renamed, namespace, default or required import, no alias.
 */
const PROBE_PROCESS_STARTS = Object.freeze([
  'spawn(command, args, spawnOptions)',
  'spawn(LAYA_PROBE_SPAWN_COMMAND, [], PROBE_SPAWN_OPTIONS)',
]);

function probeStartsAnotherProcess(code) {
  let rest = code;
  for (const call of PROBE_PROCESS_STARTS) rest = rest.replace(call, '');
  return (
    /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/.test(rest) ||
    /\bimport\s+(?!type\b)(?!\{)[^'"]*from\s*['"](?:node:)?child_process['"]/.test(rest) ||
    /\b(?:require|import)\s*\(\s*['"](?:node:)?child_process['"]/.test(rest) ||
    /\b(?:spawn|spawnSync)\s+as\b/.test(rest) ||
    /=\s*(?:spawn|spawnSync)\s*[;,)\n]/.test(rest)
  );
}

/**
 * E2 Task 12, Step 4: the static trust boundaries. The named exceptions stay exactly these and no others: the probe's
 * one loopback `fetch`, the worker runtime's one verified-tree import (both phase E's checker's rules), the
 * release-only raw-tarball acquirer, `scripts/fetch-laya-release-tarballs.mjs`, and, from E2 review round 1, the
 * probe's one refused process start (A1) and the release's one GitHub API request (A3,
 * `scripts/verify-laya-gate-runs.mjs`).
 */
const STATIC_RULES = [
  {
    id: 'laya-network-imports-probe-only',
    check(root) {
      for (const file of layaSources(root)) {
        const network = valueImports(codeOnly(readText(root, file))).filter((specifier) =>
          NETWORK_BUILTINS.test(specifier),
        );
        const allowed = file.endsWith('/worker-boundary-probe.ts') ? ['node:dgram', 'node:net'] : [];
        if (network.some((specifier) => !allowed.includes(specifier)))
          fail(`${file} imports a network built-in; only the boundary probe may, and only node:net and node:dgram`);
      }
    },
  },
  {
    id: 'laya-network-calls-named-only',
    check(root) {
      const acquirer = 'scripts/fetch-laya-release-tarballs.mjs';
      // E2 review round 1 (A3): the release's check of the protected gate runs makes its GitHub API request in one place.
      const gateRuns = 'scripts/verify-laya-gate-runs.mjs';
      const scripts = filesBelow(root, 'scripts').filter((file) => /laya/.test(file) && /\.m?[jt]s$/.test(file));
      for (const file of [...layaSources(root), ...scripts]) {
        const code = codeOnly(readText(root, file));
        const fetches = (code.match(/\bfetch\s*\(/g) ?? []).length;
        const requests = valueImports(code).filter((specifier) => /^node:https?$/.test(specifier)).length;
        if (file === gateRuns) {
          if (fetches > 1)
            fail(`${file} calls fetch more than once; the gate-run check makes its GitHub API request in one place`);
        } else if (file.endsWith('/worker-boundary-probe.ts') ? fetches > 1 : fetches > 0)
          fail(`${file} calls fetch; only the boundary probe's one loopback attempt may`);
        if (requests > 0 && file !== acquirer)
          fail(`${file} makes an HTTP request; only the release-only raw-tarball acquirer may`);
      }
    },
  },
  {
    id: 'laya-child-process-named-sites',
    check(root) {
      for (const file of layaSources(root)) {
        const code = codeOnly(readText(root, file));
        const childProcess = valueImports(code).includes('node:child_process');
        const allowed = file.endsWith('/contracts.ts') || file.endsWith('/worker-boundary-probe.ts');
        if (childProcess && !allowed)
          fail(`${file} imports node:child_process; only the availability probe and the sandbox launcher may`);
        if (/(?<![.\w$])(?:exec|execSync|execFile|execFileSync|fork)\s*\(|\bshell\s*:\s*true\b/.test(code))
          fail(
            `${file} runs a shell or another program; the Laya modules start only sandbox-exec, the availability probe's sysctl and the probe's refused attempt, never through a shell`,
          );
        if (file.endsWith('/worker-boundary-probe.ts') && probeStartsAnotherProcess(code))
          fail(`${file} starts a process beyond the sandbox launcher and the probe's one refused spawn attempt`);
      }
    },
  },
  {
    id: 'laya-no-package-manager',
    check(root) {
      for (const file of layaSources(root))
        if (/(['"`])(?:npm|npx|pnpm|yarn|corepack)\1/.test(codeOnly(readText(root, file))))
          fail(`${file} names a package manager; Laya's artifacts are installed from verified bytes, never by one`);
    },
  },
  {
    id: 'laya-tests-assert-seal',
    check(root) {
      const tests = [
        ...filesBelow(root, 'packages/events-daemon/test').filter((file) =>
          /\/laya-[^/]+\.test\.(?:ts|mjs)$/.test(file),
        ),
        ...filesBelow(root, 'test').filter((file) => /^test\/laya-[^/]+\.test\.mjs$/.test(file)),
      ];
      for (const file of tests)
        if (!/^assertLoopbackSeal\(\);$/m.test(readText(root, file)))
          fail(`${file} does not assert the loopback seal at load`);
    },
  },
  {
    id: 'laya-template-vocabulary-owned',
    check(root) {
      for (const file of filesBelow(root, 'packages/events-daemon/src')) {
        if (!file.endsWith('.ts') || file === `${LAYA_SOURCE}/templates.ts`) continue;
        if (/(['"`])laya-(?:noul|choice2)-v1\1/.test(codeOnly(readText(root, file))))
          fail(`${file} spells a Laya template id; templates.ts owns that vocabulary`);
      }
    },
  },
  {
    id: 'laya-production-spawns-shipped-entry',
    check(root) {
      for (const file of filesBelow(root, 'packages/events-daemon/src')) {
        if (!file.endsWith('.ts')) continue;
        const code = codeOnly(readText(root, file));
        if (/laya-worker-standin|\/test\/support\//.test(code))
          fail(`${file} names a test worker; production launches only the shipped worker entry`);
        if (file !== `${LAYA_SOURCE}/worker-boundary-probe.ts` && /\bworkerEntry\s*:/.test(code))
          fail(`${file} chooses a worker entry; only the boundary probe's test seam takes one`);
      }
    },
  },
  {
    id: 'laya-worker-start-owner-seam-only',
    check(root) {
      // E2 Task 13's one pass-through, exactly: the owner's `laya` test-seam option and the line that hands it to its
      // supervisor. Production passes none, so only the shipped worker launches under the sandbox.
      const ownerSeam = [
        'readonly startWorker?: LayaWorkerStart | undefined;',
        'startWorker: options.laya?.startWorker',
      ];
      for (const file of filesBelow(root, 'packages/events-daemon/src')) {
        if (!file.endsWith('.ts') || file === `${LAYA_SOURCE}/worker-supervisor.ts`) continue;
        let code = codeOnly(readText(root, file));
        if (file === 'packages/events-daemon/src/runtime/owner.ts')
          for (const seam of ownerSeam) code = code.replace(seam, '');
        if (/\bstartWorker\b/.test(code))
          fail(`${file} hands the Laya supervisor a worker start; only the owner's laya test seam passes one through`);
      }
    },
  },
  {
    id: 'laya-runtime-never-imported',
    check(root) {
      for (const file of gitListed(root)) {
        if (!/\.(?:[cm]?[jt]s|tsx)$/.test(file) || isFrozenReleaseFixture(file)) continue;
        const source = readFileSync(resolve(root, file), 'utf8');
        if (!LAYA_RUNTIME_ROOTS.some((name) => source.includes(name))) continue;
        const imported = codeImportSpecifiers(source);
        const named = imported.find((specifier) =>
          LAYA_RUNTIME_ROOTS.some((name) => specifier === name || specifier.startsWith(`${name}/`)),
        );
        if (named !== undefined)
          fail(`${file} imports ${named}; nothing outside the verified worker loads the runtime`);
      }
    },
  },
  {
    id: 'laya-gate-dispatch-only',
    check(root) {
      const workflow = readText(root, '.github/workflows/laya-quality-gate.yml');
      const on = /\non:\n([\s\S]*?)\n\S/.exec(workflow)?.[1];
      if (on?.trimEnd() !== '  workflow_dispatch:')
        fail('the Laya gate workflow must start only by hand, with no input');
      if (/github\.event\.inputs|\binputs\.|github\.head_ref|pull_request/.test(workflow))
        fail('the Laya gate workflow must read no input, pull-request ref or head ref');
    },
  },
  {
    id: 'laya-gate-runner-owned',
    check(root) {
      for (const file of filesBelow(root, '.github/workflows')) {
        if (file === '.github/workflows/laya-quality-gate.yml') continue;
        if (
          /agentcomms-laya-gate|AGENTCOMMS_LAYA_GATE_|run-laya-quality-gate|run-laya-macos-boundary-gate/.test(
            readText(root, file),
          )
        )
          fail(`${file} names the owner's Laya gate runner, its inputs or its scripts`);
      }
    },
  },
  {
    id: 'laya-gate-corpus-last',
    check(root) {
      const workflow = readText(root, '.github/workflows/laya-quality-gate.yml');
      const steps = workflow
        .slice(workflow.indexOf('\n    steps:\n'))
        .split(/\n {6}- /)
        .slice(1);
      const corpus = /AGENTCOMMS_LAYA_GATE_(?:CORPUS|CORPUS_KEY|KEY_FILE|REFERENCE|PYTHON)\b/;
      const reading = steps.flatMap((step, index) => (corpus.test(step) ? [index] : []));
      const boundary = steps.findIndex((step) => /run-laya-macos-boundary-gate\.mjs run\b/.test(step));
      if (
        reading.length !== 1 ||
        boundary === -1 ||
        reading[0] < boundary ||
        !/run-laya-quality-gate\.mjs run\b/.test(steps[reading[0]])
      )
        fail('the Laya gate reads the corpus in one step, the quality run, after the boundary run');
    },
  },
  {
    id: 'laya-sql-no-raw-identity',
    check(root) {
      for (const file of [...layaSources(root), 'packages/events-daemon/src/store/records.ts']) {
        const code = codeOnly(readText(root, file));
        const statements = [...code.matchAll(/prepare\(\s*(['"`])([\s\S]*?)\1/g)].map((match) => match[2]);
        const laya = file.endsWith('/records.ts') ? statements.filter((sql) => /laya_models/.test(sql)) : statements;
        for (const sql of laya)
          if (/\b(?:account_id|event_id|target_id|email|alias|path)\b/i.test(sql))
            fail(`${file} keys Laya state on a raw identity; model state is keyed only by manifest id`);
      }
    },
  },
  {
    id: 'desktop-two-laya-calls',
    check(root) {
      const ipc = readText(root, 'apps/desktop/src/ipc.ts');
      const union = /export type Call =([\s\S]*?);\n/.exec(ipc)?.[1] ?? '';
      const kinds = [...union.matchAll(/kind: '(eventsJudge\w+)'/g)].map((match) => match[1]).sort();
      if (kinds.join(',') !== 'eventsJudgeKindDisable,eventsJudgeModelStatus')
        fail('the desktop app calls exactly two Laya operations: status and disable');
      const rust = readText(root, 'apps/desktop/src-tauri/src/allowlist.rs');
      const variants = [
        ...new Set([...rust.matchAll(/^\s*(EventsJudge\w+) \{\},?$/gm)].map((match) => match[1])),
      ].sort();
      if (variants.join(',') !== 'EventsJudgeKindDisable,EventsJudgeModelStatus')
        fail('the desktop allow-list holds exactly two Laya calls: status and disable');
      if (!/kind: 'eventsJudgeKindEnable'/.test(ipc.slice(ipc.indexOf(union) + union.length)))
        fail('the desktop app enables Laya only by opening the terminal');
    },
  },
];

/** Every matrix row and every async Laya function this checkout has, as the checker reads them (for its own tests). */
export function e2ProofInventory({ root = repositoryRoot } = {}) {
  const resolvedRoot = resolve(root);
  const fragments = verifyCaseFiles(resolvedRoot);
  return {
    rows: [...matrixRows(resolvedRoot, fragments, declaredTests(resolvedRoot)).entries()].map(([key, row]) => ({
      key,
      ...row,
    })),
    asyncFunctions: [...lagAsyncFunctions(resolvedRoot).entries()].map(([key, occurrences]) => ({ key, occurrences })),
  };
}

function verifyStaticRules(root) {
  for (const rule of STATIC_RULES) rule.check(root);
}

export function verifyEventsPhaseE2({ root = repositoryRoot } = {}) {
  const resolvedRoot = resolve(root);
  const schema = readJson(resolvedRoot, `${casesRelative}/schema-v1.json`);
  if (
    schema.schemaVersion !== 1 ||
    schema.fragmentPattern !== 'task-<positive-integer>.json' ||
    !Array.isArray(schema.required)
  ) {
    fail('schema-v1.json is not the approved E2 fragment schema');
  }
  const fragments = [];
  verifyImmutableFragments(resolvedRoot, fragments);
  fragments.push(...verifyCaseFiles(resolvedRoot));
  if (fragments.length === 0) fail('no task-owned E2 proof fragment exists');
  const superseded = verifySupersessions(resolvedRoot, fragments);
  for (const fragment of fragments) verifyFragment(resolvedRoot, fragment, schema, superseded);
  verifyMutationLegsRun(resolvedRoot, fragments);
  verifyDaemonBoundary(resolvedRoot);
  verifyWorkerTestSeams(resolvedRoot);
  verifyTestsAreSealed(resolvedRoot);
  verifyInstallFence(resolvedRoot);
  verifyStaticRules(resolvedRoot);
  verifyMatrix(resolvedRoot, fragments, superseded);
  verifyAsyncLedger(resolvedRoot, fragments);
}

function parseArguments(argv) {
  let root = repositoryRoot;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root') root = resolve(requireString(argv[++index], '--root'));
    else fail(`unknown argument ${JSON.stringify(argv[index])}`);
  }
  return { root };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    verifyEventsPhaseE2(parseArguments(process.argv.slice(2)));
    process.stdout.write('Phase E2 proof pairing: OK\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
