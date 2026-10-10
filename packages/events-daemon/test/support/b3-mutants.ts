import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

interface MutationEntry {
  readonly case: string;
  readonly productionEntry: string;
  readonly test: string;
  readonly mutation: { readonly from: string; readonly to: string };
  readonly mutationTest: string;
  readonly loadedMarker: string;
}

function isEntry(value: unknown): value is MutationEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.case === 'string' &&
    typeof record.productionEntry === 'string' &&
    typeof record.test === 'string' &&
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

interface MutationOptions {
  readonly mutateSource: boolean;
  readonly suppressLoadedMarker: boolean;
  readonly omitMutantSource: boolean;
}

function run(argv: readonly string[], options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }) {
  return new Promise<{ readonly status: number | null; readonly output: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.once('error', reject);
    child.once('close', (status) => resolveRun({ status, output }));
  });
}

function namedTapFailure(output: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^not ok \\d+ - ${escaped}(?:\\s|$)([^\\n]*)`, 'm').exec(output);
  return match !== null && !/\\b(?:SKIP|TODO)\\b/.test(match[1] ?? '');
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
}): Promise<{ readonly status: number | null; readonly output: string }> {
  if (!isEntry(raw)) throw new Error('B3 mutation entry is malformed');
  const overlay = await mkdtemp(join(tmpdir(), 'agentcomms-b3-mutant-'));
  try {
    // Bare imports remain the real installed packages; only the resolved local closure is copied and can be rewritten.
    await symlink(join(root, 'node_modules'), join(overlay, 'node_modules'), 'dir');
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
    const env: NodeJS.ProcessEnv = { ...process.env, B3_MUTATION_CASE: raw.case };
    delete env.NODE_TEST_CONTEXT;
    const result = await run(
      [
        '--import',
        join(root, 'test/helpers/loopback-seal-preload.mjs'),
        '--import',
        observerPath,
        ...(failAfterNamedTest ? ['--import', afterTestFailurePath] : []),
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        '--test',
        '--test-name-pattern',
        raw.mutationTest,
        join(overlay, raw.test),
      ],
      { cwd: overlay, env },
    );
    if (
      !result.output
        .split(/\r?\n/)
        .some((line) => line.trim().replace(/^#\s*/, '') === `B3_MUTANT_LOADED:${raw.loadedMarker}`)
    )
      throw new Error(`${raw.case}: mutated module did not load its required marker: ${result.output.slice(-2000)}`);
    if (/\bEPERM\b/.test(result.output))
      throw new Error(`${raw.case}: named mutant test is blocked by EPERM and cannot count as mutation evidence`);
    if (result.status === 0 || result.status === null || !namedTapFailure(result.output, raw.mutationTest))
      throw new Error(
        `${raw.case}: named test did not fail: ${raw.mutationTest} (process status ${String(result.status)})`,
      );
    return result;
  } finally {
    await rm(overlay, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}
