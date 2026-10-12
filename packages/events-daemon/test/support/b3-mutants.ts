import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

interface MutationEntry {
  readonly case: string;
  readonly productionEntry: string;
  readonly test: string;
  /** Non-import repository inputs read by this exact named test, declared as repository-relative globs. */
  readonly overlayInputs?: readonly string[] | undefined;
  readonly mutation: { readonly from: string; readonly to: string };
  readonly mutationTest: string;
  readonly loadedMarker: string;
}

// Importing this parity test loads registry tooling at module evaluation time; that tooling deliberately walks every
// package manifest even when the selected named case itself only asserts an activation detail.
const REGISTRY_PARITY_TEST = 'packages/events-daemon/test/b3-cli-mcp-parity.test.ts';
// A hang guard, not a speed bound: a loaded machine runs some B3 cases (the registry-parity one walks the whole
// repository) for well over thirty seconds.
const MUTATION_CHILD_TIMEOUT_MS = 300_000;

function isEntry(value: unknown): value is MutationEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.case === 'string' &&
    typeof record.productionEntry === 'string' &&
    typeof record.test === 'string' &&
    (record.overlayInputs === undefined ||
      (Array.isArray(record.overlayInputs) &&
        record.overlayInputs.every((input) => typeof input === 'string' && input.length > 0))) &&
    typeof record.mutationTest === 'string' &&
    typeof record.loadedMarker === 'string' &&
    typeof record.mutation === 'object' &&
    record.mutation !== null &&
    typeof (record.mutation as Record<string, unknown>).from === 'string' &&
    typeof (record.mutation as Record<string, unknown>).to === 'string'
  );
}

function imports(text: string): readonly string[] {
  return [...text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)(['"])([^'"]+)\1/g)].flatMap((match) =>
    match[2] === undefined ? [] : [match[2]],
  );
}

async function sourcePath(candidate: string): Promise<string> {
  for (const path of [
    candidate,
    `${candidate}.ts`,
    `${candidate}.mjs`,
    `${candidate}.json`,
    join(candidate, 'index.ts'),
    join(candidate, 'index.mjs'),
  ]) {
    if (
      await readFile(path, 'utf8').then(
        () => true,
        () => false,
      )
    )
      return path;
  }
  throw new Error(`cannot resolve closure-local import ${candidate}`);
}

/** Preserve Node's package boundaries for a copied source/test closure without ever changing the worktree. */
async function copyPackageMetadata(root: string, overlay: string, file: string): Promise<void> {
  for (let directory = dirname(file); ; directory = dirname(directory)) {
    if (relative(root, directory).startsWith('..'))
      throw new Error(`mutation closure escaped the repository root: ${file}`);
    const metadata = join(directory, 'package.json');
    const text = await readFile(metadata, 'utf8').catch(() => undefined);
    if (text !== undefined) {
      const destination = join(overlay, relative(root, metadata));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, text);
      // Package imports in the copied closure must resolve exactly as they do from that package in the worktree.
      // The package dependency tree is installed state, not a mutation target; the closure-local source remains copied.
      const sourceModules = join(directory, 'node_modules');
      const destinationModules = join(overlay, relative(root, sourceModules));
      const modules = await lstat(sourceModules).catch(() => undefined);
      if (modules?.isDirectory()) {
        await mkdir(dirname(destinationModules), { recursive: true });
        await symlink(sourceModules, destinationModules, 'dir').catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      }
    }
    if (directory === root) return;
  }
}

async function copyClosure(
  root: string,
  overlay: string,
  entry: string,
  mutate: MutationEntry,
  { mutateSource, suppressLoadedMarker, omitMutantSource }: MutationOptions,
) {
  const seen = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    if (seen.has(file)) return;
    seen.add(file);
    let text = await readFile(file, 'utf8');
    const isMutantSource = file === resolve(root, mutate.productionEntry);
    if (isMutantSource && omitMutantSource) return;
    if (isMutantSource && mutateSource) {
      if (!text.includes(mutate.mutation.from))
        throw new Error(`${mutate.case}: mutation text is not in its production entry`);
      text = text.replace(mutate.mutation.from, mutate.mutation.to);
    }
    if (isMutantSource && mutateSource && !suppressLoadedMarker) {
      // This is overlay-only instrumentation. Its location in the copied production module proves that Node evaluated
      // the mutation target, instead of merely importing a test model or checked-in normal source.
      text += `\n(globalThis as { readonly [key: symbol]: unknown })[Symbol.for('agentcomms.b3-mutant.loaded')]?.(${JSON.stringify(
        mutate.loadedMarker,
      )});\n`;
    }
    const destination = join(overlay, relative(root, file));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, text);
    await copyPackageMetadata(root, overlay, file);
    await Promise.all(
      imports(text)
        .filter((specifier) => specifier.startsWith('.'))
        .map((specifier) => sourcePath(resolve(dirname(file), specifier)).then(visit)),
    );
  };
  await visit(resolve(root, entry));
}

function repositoryRelative(input: string, entry: MutationEntry): string {
  if (input.startsWith('/') || input.split(/[\\/]/u).includes('..'))
    throw new Error(`${entry.case}: overlay input must be a repository-relative glob: ${input}`);
  return input.split(/[\\/]/u).join('/');
}

function globSegmentMatches(pattern: string, value: string): boolean {
  const expression = pattern.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&').replaceAll('*', '[^/]*');
  return new RegExp(`^${expression}$`, 'u').test(value);
}

function globMatches(
  pattern: readonly string[],
  candidate: readonly string[],
  patternAt = 0,
  candidateAt = 0,
): boolean {
  if (patternAt === pattern.length) return candidateAt === candidate.length;
  if (pattern[patternAt] === '**')
    return (
      globMatches(pattern, candidate, patternAt + 1, candidateAt) ||
      (candidateAt < candidate.length && globMatches(pattern, candidate, patternAt, candidateAt + 1))
    );
  const patternSegment = pattern[patternAt];
  const candidateSegment = candidate[candidateAt];
  return (
    patternSegment !== undefined &&
    candidateSegment !== undefined &&
    globSegmentMatches(patternSegment, candidateSegment) &&
    globMatches(pattern, candidate, patternAt + 1, candidateAt + 1)
  );
}

async function filesBelow(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      // Overlay inputs are source: never walk installed modules, build output or another runner's `.mutants` tree,
      // which a concurrent runner may be deleting while this one scans it.
      if (entry.isDirectory()) return SNAPSHOT_SKIPPED_DIRECTORIES.has(entry.name) ? [] : filesBelow(path);
      return entry.isFile() ? [path] : [];
    }),
  );
  return files.flat();
}

export async function expandOverlayInput(
  root: string,
  input: string,
  entry: Pick<MutationEntry, 'case'>,
): Promise<readonly string[]> {
  const pattern = repositoryRelative(input, entry).split('/');
  const firstGlob = pattern.findIndex((segment) => segment.includes('*'));
  if (firstGlob < 0) return [resolve(root, ...pattern)];
  const base = resolve(root, ...pattern.slice(0, firstGlob));
  if (relative(root, base).startsWith('..'))
    throw new Error(`${entry.case}: overlay input escapes the repository root: ${input}`);
  const candidates = await filesBelow(base);
  const matches = candidates.filter((candidate) =>
    globMatches(pattern, relative(root, candidate).split(sep).join('/').split('/')),
  );
  if (matches.length === 0) throw new Error(`${entry.case}: overlay input matched no files: ${input}`);
  return matches;
}

/** Copies manifest-declared fs inputs and byte-verifies each overlay copy before the baseline executes. */
async function copyOverlayInputs(root: string, overlay: string, entry: MutationEntry): Promise<void> {
  const copied = new Set<string>();
  for (const input of entry.overlayInputs ?? []) {
    for (const source of await expandOverlayInput(root, input, entry)) {
      if (relative(root, source).startsWith('..'))
        throw new Error(`${entry.case}: overlay input escapes the repository root: ${input}`);
      const declared = relative(root, source);
      if (copied.has(declared)) continue;
      copied.add(declared);
      const contents = await readFile(source);
      const destination = join(overlay, declared);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, contents);
      const copiedContents = await readFile(destination);
      if (!contents.equals(copiedContents))
        throw new Error(`${entry.case}: overlay input was not copied exactly: ${declared}`);
    }
  }
}

/**
 * Directories a repository snapshot never copies: installed modules, build output (the packages' `dist` and Cargo's
 * `target` for the desktop app — gigabytes of generated files, never source), Git bookkeeping and another test's
 * disposable `.mutants` directory.
 */
export const SNAPSHOT_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'target',
  '.git',
  '.mutants',
]);

/**
 * Parity tests deliberately reach registry tooling which can discover any package metadata or script by filesystem
 * walk. A byte-verified repository snapshot is therefore the only honest baseline: source, tests, scripts and
 * manifests all come from the overlay, while everything in SNAPSHOT_SKIPPED_DIRECTORIES stays outside it.
 */
export async function copyRepositorySnapshot(
  root: string,
  overlay: string,
  entry: { readonly case: string },
): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      if (SNAPSHOT_SKIPPED_DIRECTORIES.has(child.name)) continue;
      const source = join(directory, child.name);
      if (child.isDirectory()) {
        await visit(source);
        continue;
      }
      if (!child.isFile()) continue;
      const destination = join(overlay, relative(root, source));
      const contents = await readFile(source);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, contents);
      const copied = await readFile(destination);
      if (!contents.equals(copied))
        throw new Error(`${entry.case}: repository snapshot changed input bytes: ${relative(root, source)}`);
    }
  };
  await visit(root);
}

interface MutationOptions {
  readonly mutateSource: boolean;
  readonly suppressLoadedMarker: boolean;
  readonly omitMutantSource: boolean;
}

function run(argv: readonly string[], options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }) {
  return new Promise<{ readonly status: number | null; readonly output: string; readonly timedOut: boolean }>(
    (resolveRun, reject) => {
      const child = spawn(process.execPath, argv, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, MUTATION_CHILD_TIMEOUT_MS);
      child.stdout.on('data', (chunk) => (output += String(chunk)));
      child.stderr.on('data', (chunk) => (output += String(chunk)));
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (status) => {
        clearTimeout(timer);
        resolveRun({ status, output, timedOut });
      });
    },
  );
}

function namedTapFailure(output: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^not ok \\d+ - ${escaped}(?:\\s|$)([^\\n]*)`, 'm').exec(output);
  return match !== null && !/\\b(?:SKIP|TODO)\\b/.test(match[1] ?? '');
}

function namedTapPass(output: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^ok \\d+ - ${escaped}(?:\\s|$)([^\\n]*)`, 'm').exec(output);
  return match !== null && !/\\b(?:SKIP|TODO)\\b/.test(match[1] ?? '');
}

function hasTapSummary(
  output: string,
  expected: { readonly tests: number; readonly pass?: number; readonly fail: number },
): boolean {
  const line = (label: string, value: number) => new RegExp(`^# ${label} ${value}\\s*$`, 'm').test(output);
  return (
    line('tests', expected.tests) &&
    line('fail', expected.fail) &&
    (expected.pass === undefined || line('pass', expected.pass))
  );
}

function commandForNamedTest(
  overlay: string,
  entry: MutationEntry,
  options: {
    readonly observerPath?: string | undefined;
    readonly afterTestFailurePath?: string | undefined;
  } = {},
): readonly string[] {
  return [
    '--import',
    pathToFileURL(join(overlay, 'test/helpers/loopback-seal-preload.mjs')).href,
    ...(options.observerPath === undefined ? [] : ['--import', pathToFileURL(options.observerPath).href]),
    ...(options.afterTestFailurePath === undefined
      ? []
      : ['--import', pathToFileURL(options.afterTestFailurePath).href]),
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    '--test',
    // The kill rule reads TAP's `# tests` / `# pass` / `# fail` summary; Node 24 defaults to the spec reporter when piped.
    '--test-reporter=tap',
    '--test-name-pattern',
    entry.mutationTest,
    join(overlay, entry.test),
  ];
}

export async function runB3Mutation({
  root,
  entry: raw,
  forceNormalSource = false,
  suppressLoadedMarker = false,
  omitMutantSource = false,
  failAfterNamedTest = false,
}: {
  readonly root: string;
  readonly entry: Record<string, unknown>;
  readonly forceNormalSource?: boolean;
  readonly suppressLoadedMarker?: boolean;
  readonly omitMutantSource?: boolean;
  /** Test seam: proves a non-zero process exit is not mistaken for the selected test's failure. */
  readonly failAfterNamedTest?: boolean;
}): Promise<{
  readonly status: number | null;
  readonly output: string;
  readonly baseline: {
    readonly status: number | null;
    readonly output: string;
    readonly timedOut: boolean;
    readonly completeRepositorySnapshot: boolean;
  };
}> {
  if (!isEntry(raw)) throw new Error('B3 mutation entry is malformed');
  const overlay = await mkdtemp(join(tmpdir(), 'agentcomms-b3-mutant-'));
  try {
    // Bare imports remain the real installed packages; only the resolved local closure is copied and can be rewritten.
    await symlink(join(root, 'node_modules'), join(overlay, 'node_modules'), 'dir');
    await copyClosure(root, overlay, raw.test, raw, {
      mutateSource: false,
      suppressLoadedMarker: true,
      omitMutantSource: false,
    });
    await copyOverlayInputs(root, overlay, raw);
    // The child's loopback seal is an input too: it runs from the overlay, never from the checkout under test.
    await mkdir(join(overlay, 'test/helpers'), { recursive: true });
    await writeFile(
      join(overlay, 'test/helpers/loopback-seal-preload.mjs'),
      await readFile(join(root, 'test/helpers/loopback-seal-preload.mjs')),
    );
    const completeRepositorySnapshot = raw.overlayInputs !== undefined || raw.test === REGISTRY_PARITY_TEST;
    if (completeRepositorySnapshot) await copyRepositorySnapshot(root, overlay, raw);
    const env: NodeJS.ProcessEnv = { ...process.env, B3_MUTATION_CASE: raw.case };
    delete env.NODE_TEST_CONTEXT;
    // A mutant is evidence only when this exact named test is first green in the same source/test/files overlay.
    const baseline = {
      ...(await run(commandForNamedTest(overlay, raw), { cwd: overlay, env })),
      completeRepositorySnapshot,
    };
    if (baseline.timedOut)
      throw new Error(
        `${raw.case}: unmutated named test timed out after ${MUTATION_CHILD_TIMEOUT_MS} ms and was killed\n${baseline.output.slice(-2000)}`,
      );
    if (/\bEPERM\b/.test(baseline.output))
      throw new Error(`${raw.case}: unmutated named test is blocked by EPERM and cannot count as mutation evidence`);
    if (
      baseline.status !== 0 ||
      !namedTapPass(baseline.output, raw.mutationTest) ||
      !hasTapSummary(baseline.output, { tests: 1, pass: 1, fail: 0 })
    )
      throw new Error(
        `${raw.case}: unmutated overlay named test did not pass: ${raw.mutationTest}\n${baseline.output.slice(-2000)}`,
      );
    await copyClosure(root, overlay, raw.test, raw, {
      mutateSource: !forceNormalSource,
      suppressLoadedMarker,
      omitMutantSource,
    });
    const observerPath = join(overlay, 'b3-mutant-observer.mjs');
    await writeFile(
      observerPath,
      `globalThis[Symbol.for('agentcomms.b3-mutant.loaded')] = (marker) => process.stdout.write('B3_MUTANT_LOADED:' + marker + '\\n');\n`,
    );
    const afterTestFailurePath = join(overlay, 'b3-mutation-after-test-failure.mjs');
    if (failAfterNamedTest) {
      await writeFile(
        afterTestFailurePath,
        "setTimeout(() => { throw new Error('B3_MUTATION_AFTER_NAMED_TEST'); }, 100);\n",
      );
    }
    const result = await run(
      commandForNamedTest(overlay, raw, {
        observerPath,
        ...(failAfterNamedTest ? { afterTestFailurePath } : {}),
      }),
      { cwd: overlay, env },
    );
    if (result.timedOut)
      throw new Error(
        `${raw.case}: mutated named test timed out after ${MUTATION_CHILD_TIMEOUT_MS} ms and was killed\n${result.output.slice(-2000)}`,
      );
    if (
      !result.output
        .split(/\r?\n/)
        .some((line) => line.trim().replace(/^#\s*/, '') === `B3_MUTANT_LOADED:${raw.loadedMarker}`)
    )
      throw new Error(`${raw.case}: mutated module did not load its required marker: ${result.output.slice(-2000)}`);
    if (/\bEPERM\b/.test(result.output))
      throw new Error(`${raw.case}: named mutant test is blocked by EPERM and cannot count as mutation evidence`);
    if (
      result.status === 0 ||
      result.status === null ||
      !namedTapFailure(result.output, raw.mutationTest) ||
      !hasTapSummary(result.output, { tests: 1, fail: 1 })
    )
      throw new Error(
        `${raw.case}: mutant named test did not fail exactly once: ${raw.mutationTest} (process status ${String(result.status)})`,
      );
    return { ...result, baseline };
  } finally {
    await rm(overlay, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}
