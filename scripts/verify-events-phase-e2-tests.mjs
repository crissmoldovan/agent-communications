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

function verifyFragment(root, fragment, schema) {
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
  for (const fragment of fragments) verifyFragment(resolvedRoot, fragment, schema);
  verifyMutationLegsRun(resolvedRoot, fragments);
  verifyDaemonBoundary(resolvedRoot);
  verifyTestsAreSealed(resolvedRoot);
  verifyInstallFence(resolvedRoot);
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
