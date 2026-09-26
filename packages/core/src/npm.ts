import { spawn } from 'node:child_process';
import { displayUrl } from './mcp-clients.ts';
import { findNpmCli } from './mcp-install.ts';

/**
 * What an update asks of npm: the latest release of this suite's packages, which of them are installed globally, and
 * installing one globally at an exact version.
 *
 * Each is a plain function over an environment, so the update takes them as parameters and a test hands it stand-ins:
 * nothing in a test reads the real registry or the machine's global packages. Only reading the registry happens here —
 * never a publish, a login or a dist-tag change.
 */

/**
 * A version, exactly as semver writes one: `1.2.3`, `1.2.3-rc.1`, `1.2.3+build`.
 *
 * Anything the registry answers is checked against this before it is used, because a version goes into a directory
 * name (`runtime/<version>-gmail`), a sentence a person approves, and an argument to `npm install`. A registry — or a
 * mirror somebody configured — that answered `../x` or `1.0.0 && …` would otherwise put that in all three.
 */
export const VERSION_PATTERN: RegExp =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_PATTERN.test(value);
}

/** Two numeric strings with no leading zeros, compared as numbers of any size. */
function compareNumeric(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Semver precedence: -1, 0 or 1, or null when either is not a version.
 *
 * Numbers compare as numbers (`0.10.0` is after `0.9.9`), a prerelease comes before its release, and build metadata
 * counts for nothing. Written out rather than taken from a dependency: it is twenty lines, and the core installs as
 * few packages as it can.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = VERSION_PATTERN.exec(a);
  const right = VERSION_PATTERN.exec(b);
  if (!left || !right) return null;
  for (const index of [1, 2, 3]) {
    const order = compareNumeric(left[index] ?? '0', right[index] ?? '0');
    if (order !== 0) return order < 0 ? -1 : 1;
  }
  const pre = (match: RegExpExecArray) => (match[4] === undefined ? [] : match[4].split('.'));
  const [ours, theirs] = [pre(left), pre(right)];
  if (ours.length === 0 || theirs.length === 0) {
    return ours.length === theirs.length ? 0 : ours.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(ours.length, theirs.length); index += 1) {
    const x = ours[index];
    const y = theirs[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [numericX, numericY] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (numericX && numericY) {
      const order = compareNumeric(x, y);
      if (order !== 0) return order < 0 ? -1 : 1;
    } else if (numericX !== numericY) {
      return numericX ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Whether `version` is older than `latest`: by semver when both are versions, and otherwise whenever they differ. */
export function isBehind(version: string, latest: string): boolean {
  if (version === latest) return false;
  const order = compareVersions(version, latest);
  return order === null ? true : order < 0;
}

export const REGISTRY_TIMEOUT_MS = 10_000;

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

/**
 * The registry npm itself would read: `npm_config_registry` when it is set — which npm sets for everything it runs,
 * and which a person can export to use a mirror — and the public registry otherwise.
 */
export function registryUrl(env: NodeJS.ProcessEnv): string {
  const configured = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  if (configured && /^https?:\/\//i.test(configured)) return configured.endsWith('/') ? configured : `${configured}/`;
  return DEFAULT_REGISTRY;
}

/**
 * The version the registry's `latest` dist-tag names for one package, read from npm's abbreviated package document —
 * the one `npm install` itself reads, which every registry and mirror serves.
 *
 * It fails rather than guesses: a registry that does not answer within the timeout, answers with an error, or answers
 * without a `latest` tag is an error saying which. The registry is named in a failure by its scheme and host only: a
 * configured address can carry a token.
 */
export async function npmLatestVersion(
  packageName: string,
  options: {
    env: NodeJS.ProcessEnv;
    fetch?: typeof fetch | undefined;
    timeoutMs?: number | undefined;
  },
): Promise<string> {
  const base = registryUrl(options.env);
  const where = displayUrl(base) ?? 'the npm registry';
  const timeoutMs = options.timeoutMs ?? REGISTRY_TIMEOUT_MS;
  // npm's own spelling of a package in a registry path: a scope's slash escaped, its `@` not.
  const url = new URL(packageName.replace('/', '%2f'), base);
  const headers: Record<string, string> = {
    accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8',
  };
  // A mirror's address with a user and password in it means basic authentication; `fetch` refuses such a URL whole.
  if (url.username || url.password) {
    const user = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    headers.authorization = `Basic ${Buffer.from(user).toString('base64')}`;
    url.username = '';
    url.password = '';
  }
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = (error as { name?: unknown } | undefined)?.name;
    const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
    throw new Error(
      name === 'TimeoutError' || name === 'AbortError'
        ? `no answer from ${where} within ${timeoutMs / 1000} s`
        : `${where} could not be reached${typeof code === 'string' ? ` (${code})` : ''}`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${where} answered ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${where} answered something that is not JSON`);
  }
  const latest = (body as { 'dist-tags'?: { latest?: unknown } } | null)?.['dist-tags']?.latest;
  if (typeof latest !== 'string') throw new Error(`${where} names no \`latest\` release`);
  return latest;
}

/** A command's exit status and output, given up on after `timeoutMs`. */
function capture(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`npm did not finish within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * The versions of `names` installed globally, by `npm ls -g --depth=0 --json` through the npm beside this Node — the
 * one `npm install -g` would then use. A package not installed is left out.
 *
 * `npm ls` exits non-zero for a tree it has something to say about and still prints the tree, so the answer is read
 * whatever the exit status; an answer that is not the tree, or an error npm reports, throws with why. A global
 * directory that does not exist yet is nothing installed.
 */
export async function npmGlobalPackages(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): Promise<Record<string, string>> {
  const npmCli = await findNpmCli();
  const { stdout } = await capture(
    [npmCli, 'ls', '--global', '--depth=0', '--json', '--no-update-notifier'],
    env,
    60_000,
  );
  let tree: { dependencies?: Record<string, { version?: unknown }>; error?: { code?: unknown } };
  try {
    tree = JSON.parse(stdout) as typeof tree;
  } catch {
    throw new Error('`npm ls --global` did not answer with its JSON tree');
  }
  if (tree.error) {
    if (tree.error.code === 'ENOENT') return {};
    throw new Error(`\`npm ls --global\` failed (${String(tree.error.code ?? 'an error')})`);
  }
  const found: Record<string, string> = {};
  for (const name of names) {
    const version = tree.dependencies?.[name]?.version;
    if (isVersion(version)) found[name] = version;
  }
  return found;
}

/** `npm install -g <spec>`, through the npm beside this Node. Rejects with the end of what npm said when it fails. */
export async function npmInstallGlobal(env: NodeJS.ProcessEnv, spec: string): Promise<void> {
  const npmCli = await findNpmCli();
  const { code, stderr } = await capture(
    [npmCli, 'install', '--global', '--no-audit', '--no-fund', '--no-update-notifier', spec],
    env,
    10 * 60_000,
  );
  if (code !== 0) {
    const said = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
    throw new Error(`npm install --global ${spec} failed${said ? `: ${said}` : ''}`);
  }
}
