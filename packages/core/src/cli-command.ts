import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNEL_SNAPSHOT } from './channels.generated.ts';
import { normalizePathOptionWords } from './cli-runtime.ts';
import { quoteCommand, quotedText } from './command-line.ts';
import { launcherCanStartSync, launcherName, launcherPaths, readPointerSync } from './launcher.ts';
import { managedShimStarting } from './managed-shims.ts';
import type { RegisteredServer } from './mcp-clients.ts';
import { nodeProgram } from './node-program.ts';
import { isWithin, nearestPackage, readPackageManifest, realpathOfExisting, suiteCommandOf } from './package-roots.ts';
import { type PathName, type PathOverrides, type ResolvedPaths, withoutPathOptions } from './paths.ts';
import {
  isNpxRegistration,
  launcherOf,
  type RegistrationFacts,
  type RegistrationLauncher,
  registrationFactsOf,
  registrationFiles,
  registrationVersion,
  startsProduct,
} from './registrations.ts';
import { VERSION } from './version.ts';
import { satisfiesRange } from './versions.ts';

/**
 * The command a person is told to run for one of this suite's own CLIs (design 2026-10-04, D1 and D5; CUE-403).
 *
 * A bare `agent-gmail approve …` is not runnable for most of the people it is printed for: a package run by npx, by a
 * managed runtime or from a checkout puts nothing on their PATH. So every such command names this process's Node and
 * a checked file of the product it runs, with the suite directories it uses pinned as options — and when no file can
 * be checked, there is no command at all, only a sentence saying what is missing. The caller says which package it is
 * and what to run; it never supplies the program or quotes the line.
 *
 * Three directions. A product's own CLI is found from the product itself, walking from one of its own modules to its
 * manifest: no registration is ever asked. A channel's handoff to core is found the way the channel itself finds core,
 * through its installed dependency, and only the same release. Another product's command is found among the servers
 * registered with the person's MCP clients, which the caller scanned and passes in: only a file-backed registration of
 * exactly the printing package's version, checked on disk. Nothing a registration names is run, or asked anything —
 * not even its interpreter for a version: no installer wrote down where a scanned entry came from, so none is trusted
 * to run (D1). This module never scans, spawns or probes.
 *
 * What is checked is checked when the command is printed, not for ever (D6): the file it names is real, readable and
 * inside its package then, and a later change to that installation is a later fact.
 */

/** The gate a constructor call has to pass: only this module holds it. */
const GATE: unique symbol = Symbol('locateCliCommand');

/**
 * A command that runs one of this suite's own CLIs, made only by `locateCliCommand`. Rendered as every printed command
 * is — a line to paste, or on Windows its words as JSON when no line is safe in every shell (`inlineCommand`,
 * `commandText`).
 *
 * A class with a private field, so the type is nominal: an object literal with the same fields is not one, and nor is
 * a spread copy of one with other words in it, as it would be with a symbol-keyed brand. Only the type is exported;
 * the class and its gate are not.
 */
class PrintedCommand {
  readonly #entry: string;
  /** The words, as the program is to receive them: this Node, its flags, the entry, then the CLI's own words. */
  readonly words: readonly string[];
  /** The line to paste; null when no supported common or labelled shell rendering is safe. */
  readonly line: string | null;
  readonly platform: NodeJS.Platform;
  readonly shell?: 'powershell' | undefined;

  constructor(gate: typeof GATE, words: readonly string[], platform: NodeJS.Platform, entry: string) {
    if (gate !== GATE) throw new TypeError('a printed command is made by locateCliCommand, and only there');
    this.#entry = entry;
    this.words = Object.freeze([...words]);
    const quoted = quoteCommand(this.words, platform);
    this.line = quoted.line;
    this.platform = platform;
    if (quoted.shell !== undefined) this.shell = quoted.shell;
    Object.freeze(this);
  }

  /**
   * The real path of the file it runs, as it was checked when the command was located: a fact about then (D6). The
   * command names this path and nothing else, so what runs is whatever is there when the person runs it.
   */
  get entry(): string {
    return this.#entry;
  }

  /**
   * As JSON — a result's field written out by `--json`, or returned to an MCP client — it is the text it always was:
   * its line, or its words as JSON with what to do when no Windows line is safe (`commandText`). Rendered where it
   * leaves the process, so a field can hold the command itself and the wire stays the same.
   */
  toJSON(): string {
    return quotedText(this);
  }

  /** Never interpolated: a sentence gives a command through `handoffSentence`, a value through `handoffText`. */
  [Symbol.toPrimitive](): never {
    throw new TypeError('a printed command is rendered with handoffText or handoffSentence, never interpolated');
  }
}

export type { PrintedCommand };

/** The package asking: a module of its own (`import.meta.url`), and the package that module is expected to be in. */
export interface CliCommandCaller {
  readonly url: string;
  readonly packageName: string;
}

/** The manifest facts the locator needs for any declared suite CLI, including a non-channel service. */
export interface CliCommandTarget {
  readonly packageName: string;
  readonly manifest: {
    readonly channel?: string | undefined;
    readonly label: string;
    readonly binary: string;
  };
}

export interface CliCommandRequest {
  readonly caller: CliCommandCaller;
  /** The product whose CLI is to run, as core's snapshot of the manifests has it. */
  readonly target: CliCommandTarget;
  /** The CLI's own words: its subcommand and arguments, never the program. */
  readonly words: readonly string[];
  /** The suite directories the command reads or writes, each pinned to its value in `paths`; no other is. */
  readonly uses: readonly PathName[];
  /** The printing process's resolved directories. */
  readonly paths: Readonly<ResolvedPaths>;
  /**
   * The shell the line is quoted for, and the system the registrations were made on: on Windows their names and paths
   * are read without case.
   */
  readonly platform?: NodeJS.Platform | undefined;
  /**
   * For another product's command: the servers registered with this machine's MCP clients — the `servers` of a
   * `scanRegisteredServers` the caller has already awaited. Left out, that direction has no command; the other two
   * never read it.
   */
  readonly registrations?: readonly RegisteredServer[] | undefined;
  /**
   * The environment whose PATH this Node is named from (CUE-492): the printing process's own. The command names the
   * first `node` there that is this very Node, as PATH spells it — a link such as `~/.local/bin/node` stays the link,
   * as a registration names it — and otherwise `process.execPath`, which the system reports resolved. Left out,
   * nothing is looked for and the command names `process.execPath`.
   */
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/**
 * The Node a command is located for: this process's, unless a test says otherwise. Its program is always this Node —
 * named as PATH finds it (`CliCommandRequest.env`), and checked to be this one's real file.
 */
export interface NodeRuntime {
  /** `process.version`, checked against the target's `engines.node`. */
  readonly version: string;
  /**
   * `process.execArgv`, read only for whether `--experimental-transform-types` was used. A preload, loader, inspector,
   * condition or memory flag this process was started with is never carried into a command, nor is a `NODE_OPTIONS` it
   * has; the person's own `NODE_OPTIONS` still applies when they run it, inside their shell and the same-OS-user
   * boundary, which a printed command does not move (D6, SECURITY.md).
   */
  readonly execArgv: readonly string[];
}

export type CliDirection = 'own' | 'channel-to-core' | 'cross-product';

/** What a located command starts: a source CLI, a manifest's bin, or a managed runtime's stable launcher or shim. */
export type EntryKind = 'source' | 'bin' | 'launcher' | 'shim';

/** What a located command was decided from, so that a test, and a person reading a report, can see why. */
export interface CliCommandBasis {
  readonly direction: CliDirection;
  /** The caller's module is TypeScript source: its URL ends in `.ts`. */
  readonly callerSource: boolean;
  /** The caller's package root, real. */
  readonly callerRoot: string;
  readonly callerVersion: string | null;
  /** The target's package root, real: the caller's own for `own`. */
  readonly targetRoot: string;
  readonly targetVersion: string | null;
  /** The real repository checkout each root is a workspace package of, or null; channel to core only. */
  readonly callerWorkspace: string | null;
  readonly targetWorkspace: string | null;
  /** Both are workspace packages of one checkout: always so for `own`, where they are one package; never for another. */
  readonly sameCheckout: boolean;
  /**
   * `src/cli.ts`, or the manifest's bin; or, for a managed runtime of this installation, the stable way in that starts
   * that same release (`stableWayIn`): its stable launcher, else its managed CLI shim.
   */
  readonly entryKind: EntryKind;
  /** For another product: the registration it was found by. Never its command or arguments, which can hold a token. */
  readonly registration?: RegistrationUsed | undefined;
}

export interface RegistrationUsed {
  readonly client: string;
  readonly path: string;
  readonly name: string;
  readonly launcher: RegistrationLauncher;
}

/** Why there is no command: the step that found nothing it could check. */
export type CliNotLocatedReason =
  | 'caller'
  | 'manifest'
  | 'core'
  | 'version'
  | 'engine'
  | 'bin'
  | 'entry'
  | 'interpreter'
  | 'arguments'
  | 'direction'
  | 'no-registrations'
  | 'not-registered';

/** Why one registration of the product was not used. */
export type RegistrationRejection =
  | 'npx'
  | 'arguments'
  | 'no-file'
  | 'no-package'
  | 'version'
  | 'engine'
  | 'bin'
  | 'entry';

export interface RegistrationNotUsed {
  readonly client: string;
  readonly path: string;
  readonly name: string;
  readonly why: RegistrationRejection;
}

/**
 * A command, and what it was decided from. Identity at the time of printing, not immutability (D6): every check held
 * when it was made. An npx cache evicted later leaves a command that fails with the missing file; an installation
 * upgraded or replaced in place leaves one that runs what is then at that path. Neither is ever swapped for a command
 * found by name on PATH, and locating again checks everything again.
 */
export interface CliCommandLocated {
  readonly ok: true;
  readonly command: PrintedCommand;
  readonly basis: CliCommandBasis;
}

/**
 * No command: nothing to run, and a sentence naming the product, its package and the exact version it needs. An
 * installation that has gone or changed since is said so, never replaced by a suite command found by name on PATH.
 */
export interface CliCommandNotLocated {
  readonly ok: false;
  readonly reason: CliNotLocatedReason;
  /** How the product is named to a person: `Gmail`. */
  readonly product: string;
  readonly package: string;
  /** The exact version needed: the printing package's own, since the suite is released together. */
  readonly version: string;
  /** For `engine`: the Node range the target declares. */
  readonly nodeRange?: string | undefined;
  /** For another product: each registration of it that was looked at, and why it was not used. */
  readonly registrations?: readonly RegistrationNotUsed[] | undefined;
  /** What was found, in a clause. */
  readonly detail: string;
  /** The whole sentence to show. */
  readonly message: string;
}

export type CliCommandResult = CliCommandLocated | CliCommandNotLocated;

const STRIP_TYPES = '--experimental-strip-types';
const TRANSFORM_TYPES = '--experimental-transform-types';

/** The suite's packages, by name, and its channel packages, which reach core through their own dependency on it. */
const SUITE_PACKAGES: ReadonlySet<string> = new Set(CHANNEL_SNAPSHOT.map(({ packageName }) => packageName));
const CHANNEL_PACKAGES: ReadonlySet<string> = new Set(
  CHANNEL_SNAPSHOT.filter(({ manifest }) => manifest.channel !== 'core').map(({ packageName }) => packageName),
);

/** What was found to run: a package's real root, its manifest, and whether its source CLI is the entry. */
interface Found {
  readonly root: string;
  readonly manifest: Record<string, unknown>;
  readonly source: boolean;
}

/** What a found package came to: a command, or the step that stopped it. */
type Built =
  | { ok: true; command: PrintedCommand; entryKind: EntryKind }
  | { ok: false; reason: 'engine' | 'bin' | 'entry'; detail: string; nodeRange?: string };

/**
 * Locates the command that runs `request.target`'s CLI with `request.words`, or says why there is none.
 *
 * The program is always this process's Node, which must satisfy the target's `engines.node`; no interpreter named
 * anywhere else is run, or asked its version. It is named as PATH finds it — the first `node` on `request.env`'s PATH
 * that is the same real file as `process.execPath` — and otherwise by `process.execPath` (CUE-492): the real file only
 * identifies it, and `process.version` is that file's. A TypeScript entry gets `--experimental-strip-types`,
 * which Node 22.12–22.17 needs, and `--experimental-transform-types` only when this source run was started with it;
 * no other flag this process was started with is carried — debug, preload, condition and memory flags are not what the
 * CLI needs. The suite directories the command uses go between the entry and its words, one canonical option each,
 * before any `--`.
 *
 * Synchronous, so a hint or a renderer can call it where it builds its sentence; for another product the caller scans
 * the registrations first and passes them in (`request.registrations`).
 */
export function locateCliCommand(
  request: CliCommandRequest,
  runtime: NodeRuntime = { version: process.version, execArgv: process.execArgv },
): CliCommandResult {
  const { caller, target } = request;
  const [first] = request.words;
  if (first !== undefined && (isAbsolute(first) || suiteCommandOf(first) !== null)) {
    throw new TypeError(`the words to run start after the program: ${JSON.stringify(first)} is one`);
  }
  const platform = request.platform ?? process.platform;
  // The exact version needed is the printing package's: the suite is released together.
  let version = VERSION;
  const fail = (
    reason: CliNotLocatedReason,
    detail: string,
    extra: { nodeRange?: string | undefined; registrations?: readonly RegistrationNotUsed[] } = {},
  ) => notLocated(target, version, reason, detail, runtime.version, extra);

  let callerFile: string;
  try {
    callerFile = fileURLToPath(caller.url);
  } catch {
    return fail('caller', `${caller.url} is not a module on this machine`);
  }
  const callerSource = callerFile.endsWith('.ts');
  // The package a module belongs to is the nearest manifest, and it has to be the one the caller says it is: a module
  // of a wrapper, or of a bundle that copied this code, would otherwise locate itself as the product.
  const nearest = nearestPackage(dirname(callerFile));
  const callerManifest = nearest?.manifest ?? null;
  if (nearest === null || callerManifest === null || callerManifest.name !== caller.packageName) {
    const name = typeof callerManifest?.name === 'string' ? callerManifest.name : 'no named package';
    return fail('manifest', `the package ${callerFile} belongs to is ${name}, not ${caller.packageName}`);
  }
  const callerVersion = typeof callerManifest.version === 'string' ? callerManifest.version : null;
  if (callerVersion !== null) version = callerVersion;
  let callerRoot: string;
  try {
    callerRoot = realpathSync(nearest.root);
  } catch {
    return fail('caller', `${nearest.root} cannot be resolved`);
  }
  if (!isAbsolute(process.execPath)) return fail('interpreter', `this Node, ${process.execPath}, is not a full path`);
  // This Node, as PATH finds it: a link stays the link, so a command or a shim outlives its owner's moving the file.
  const program = nodeProgram(request.env);

  const pins: PathOverrides = {};
  for (const key of request.uses) pins[key] = request.paths[key];
  let words: string[];
  try {
    words = normalizePathOptionWords(request.words, pins, 0);
  } catch (error) {
    return fail('arguments', error instanceof Error ? error.message : String(error));
  }
  const build = (found: Found) =>
    stableWayIn(buildCommand(target, found, words, runtime, callerSource, platform, program), found, target, {
      paths: request.paths,
      env: request.env,
      words,
      platform,
      program,
    });
  // What every located command was decided from; each direction adds its own.
  const located = (
    built: Built & { ok: true },
    found: Found,
    direction: Pick<CliCommandBasis, 'direction' | 'sameCheckout'> &
      Partial<Pick<CliCommandBasis, 'callerWorkspace' | 'targetWorkspace' | 'registration'>>,
  ): CliCommandLocated =>
    Object.freeze({
      ok: true as const,
      command: built.command,
      basis: Object.freeze({
        callerSource,
        callerRoot,
        callerVersion,
        targetRoot: found.root,
        targetVersion: typeof found.manifest.version === 'string' ? found.manifest.version : null,
        callerWorkspace: null,
        targetWorkspace: null,
        entryKind: built.entryKind,
        ...direction,
      }),
    });

  if (caller.packageName === target.packageName) {
    const found = { root: callerRoot, manifest: callerManifest, source: callerSource };
    const built = build(found);
    if (!built.ok) return fail(built.reason, built.detail, { nodeRange: built.nodeRange });
    return located(built, found, { direction: 'own', sameCheckout: true });
  }

  if (target.manifest.channel === 'core' && CHANNEL_PACKAGES.has(caller.packageName)) {
    // Core as the channel itself finds it: its installed dependency, not core's exported module or a sibling folder.
    const installed = installedPackage(dirname(callerFile), target.packageName);
    if (installed === null) {
      return fail('core', `${caller.packageName} has no ${target.packageName} installed where it can find one`);
    }
    const manifest = readPackageManifest(installed);
    if (manifest === null || manifest.name !== target.packageName) {
      return fail('manifest', `the package found as ${target.packageName}, at ${installed}, is not that package`);
    }
    if (manifest.version !== version) {
      const theirs = typeof manifest.version === 'string' ? manifest.version : 'of no version';
      return fail('version', `${caller.packageName} ${version} finds ${target.packageName} ${theirs}, at ${installed}`);
    }
    // Core's source runs only beside a channel's source, as one checkout: never because a path happens to end in `.ts`.
    const callerWorkspace = workspaceOf(callerRoot);
    const targetWorkspace = workspaceOf(installed);
    const sameCheckout = callerWorkspace !== null && callerWorkspace === targetWorkspace;
    const found = { root: installed, manifest, source: callerSource && sameCheckout };
    const built = build(found);
    if (!built.ok) return fail(built.reason, built.detail, { nodeRange: built.nodeRange });
    return located(built, found, { direction: 'channel-to-core', callerWorkspace, targetWorkspace, sameCheckout });
  }

  if (!SUITE_PACKAGES.has(caller.packageName)) {
    return fail('direction', `${caller.packageName} is not a package of this suite`);
  }
  if (request.registrations === undefined) {
    return fail('no-registrations', "nothing registered was given to look through for another product's command");
  }

  // Another product: every registration of it, each checked as a file on disk; the best of those that pass.
  const channelTarget = CHANNEL_SNAPSHOT.find((entry) => entry.packageName === target.packageName);
  if (channelTarget === undefined) {
    return fail(
      'direction',
      `${target.packageName} is not a channel package this locator can find through a registration`,
    );
  }
  const facts = registrationFactsOf(channelTarget);
  const notUsed: RegistrationNotUsed[] = [];
  const usable: {
    server: RegisteredServer;
    launcher: RegistrationLauncher;
    built: Built & { ok: true };
    found: Found;
  }[] = [];
  let engineRange: string | undefined;
  for (const server of request.registrations) {
    if (!startsProduct(server, facts, platform)) continue;
    const reject = (why: RegistrationRejection) =>
      notUsed.push(Object.freeze({ client: server.client, path: server.path, name: server.name, why }));
    // npx picks its own Node from the person's PATH, and its cache may be gone: neither can be checked now (D1).
    if (isNpxRegistration(server, facts, platform)) {
      reject('npx');
      continue;
    }
    if (withoutPathOptions(server.args).dangling) {
      reject('arguments');
      continue;
    }
    const launcher = launcherOf(server, facts, platform);
    const files = registrationFiles(server, facts, platform);
    const absolute = [...files.scripts, ...(files.command === null ? [] : [files.command])].some((file) =>
      isAbsolute(file),
    );
    if (!absolute) {
      reject('no-file');
      continue;
    }
    const found = registeredPackage(files, target, facts);
    if (found === null) {
      reject('no-package');
      continue;
    }
    const managedAt = launcher === 'managed' ? registrationVersion(server, facts, platform) : version;
    if (found.manifest.version !== version || managedAt !== version) {
      reject('version');
      continue;
    }
    const built = build(found);
    if (!built.ok) {
      reject(built.reason);
      if (built.reason === 'engine') engineRange ??= built.nodeRange;
      continue;
    }
    usable.push({ server, launcher, built, found });
  }
  // A managed runtime first, then any other checked file; within each, by client, config file, name, command, words.
  const rank = ({ server, launcher }: (typeof usable)[number]) => [
    launcher === 'managed' ? '0' : '1',
    server.client,
    server.path,
    server.name,
    server.command,
    ...server.args,
  ];
  const [best] = usable.sort((a, b) => compareWords(rank(a), rank(b)));
  if (best === undefined) {
    if (engineRange !== undefined) {
      return fail('engine', `it needs Node ${engineRange}, and this is Node ${runtime.version}`, {
        nodeRange: engineRange,
        registrations: notUsed,
      });
    }
    return fail('not-registered', notRegistered(notUsed, version), { registrations: notUsed });
  }
  const { client, path, name } = best.server;
  return located(best.built, best.found, {
    direction: 'cross-product',
    sameCheckout: false,
    registration: Object.freeze({ client, path, name, launcher: best.launcher }),
  });
}

/**
 * Checks what was found and makes its command: the target's Node range against this Node, then the entry — the source
 * CLI or the manifest's bin for the command it declares — as a readable file inside its package.
 */
function buildCommand(
  target: CliCommandTarget,
  found: Found,
  words: readonly string[],
  runtime: NodeRuntime,
  callerSource: boolean,
  platform: NodeJS.Platform,
  program: string,
): Built {
  const engines = found.manifest.engines;
  const range = typeof engines === 'object' && engines !== null ? (engines as Record<string, unknown>).node : undefined;
  if (typeof range !== 'string') {
    return {
      ok: false,
      reason: 'engine',
      detail: `${target.packageName} at ${found.root} declares no Node range this can check`,
    };
  }
  if (satisfiesRange(runtime.version, range) !== true) {
    return {
      ok: false,
      reason: 'engine',
      detail: `it needs Node ${range}, and this is Node ${runtime.version}`,
      nodeRange: range,
    };
  }
  let entry: string;
  if (found.source) {
    // Exactly the source CLI, and never a build beside it: a checkout with no build, or a stale one, runs its source.
    entry = join(found.root, 'src', 'cli.ts');
  } else {
    const binary = declaredBinary(found.manifest);
    const bin = found.manifest.bin;
    const path =
      binary === target.manifest.binary &&
      typeof bin === 'object' &&
      bin !== null &&
      Object.hasOwn(bin, target.manifest.binary)
        ? (bin as Record<string, unknown>)[target.manifest.binary]
        : undefined;
    if (typeof path !== 'string' || path.length === 0) {
      return {
        ok: false,
        reason: 'bin',
        detail: `the bin of ${target.packageName} at ${found.root} does not name the command it declares`,
      };
    }
    entry = resolve(found.root, path);
  }
  const checked = checkedEntry(found.root, entry);
  if (checked.ok === false) return { ok: false, reason: 'entry', detail: checked.why };
  const typescript = /\.[cm]?ts$/.test(checked.path);
  const flags = typescript
    ? [STRIP_TYPES, ...(callerSource && runtime.execArgv.includes(TRANSFORM_TYPES) ? [TRANSFORM_TYPES] : [])]
    : [];
  const command = new PrintedCommand(GATE, [program, ...flags, checked.path, ...words], platform, checked.path);
  return { ok: true, command, entryKind: found.source ? 'source' : 'bin' };
}

/**
 * A managed runtime's command, as its stable way in (0.21). A command naming `<data>/runtime/0.20.0-core/…/cli.mjs`
 * stops working once that runtime is pruned — and the background job prunes old runtimes after each update — so a
 * command printed from a managed runtime of this installation names what stays put instead:
 *
 * - **its stable launcher**, `<data>/launch/<name>` (`launcherPaths`), when it is there and its pointer names a runtime
 *   holding this package at exactly this release, whose CLI can start: the launcher, then the words, as a registration
 *   starts it — on Windows, where the launcher is a script Node runs, this Node first;
 * - else **its managed CLI shim**, where shims are offered, when this installation's receipt records one that is
 *   unchanged and starts this very entry (`managedShimStarting`): a release before the launcher wrote such shims, and
 *   an update rewrites them;
 * - else the runtime's entry, as before.
 *
 * Only for a package inside `<data>/runtime` of the folders this command pins: a checkout, an npx cache, a global
 * install or another data folder's runtime is named as it always was. Checked when the command is printed (D6), as the
 * entry is: a launcher switched later runs what it is then switched to, as every registration that starts it does.
 */
function stableWayIn(
  built: Built,
  found: Found,
  target: CliCommandTarget,
  printing: {
    readonly paths: Readonly<ResolvedPaths>;
    readonly env: NodeJS.ProcessEnv | undefined;
    readonly words: readonly string[];
    readonly platform: NodeJS.Platform;
    readonly program: string;
  },
): Built {
  if (!built.ok || found.source) return built;
  const { paths, words, platform, program } = printing;
  const runtimes = realpathOfExisting(join(paths.dataDir, 'runtime'));
  if (runtimes === null || !isWithin(runtimes, found.root) || resolve(runtimes) === resolve(found.root)) return built;
  const launcher = stableLauncher(paths.dataDir, target.packageName, found.manifest.version, platform);
  if (launcher !== null) {
    const command = new PrintedCommand(
      GATE,
      platform === 'win32' ? [program, launcher, ...words] : [launcher, ...words],
      platform,
      realpathOfExisting(launcher) ?? launcher,
    );
    return { ok: true, command, entryKind: 'launcher' };
  }
  const shim = managedShimStarting(
    { env: printing.env ?? process.env, dataDir: paths.dataDir, platform },
    target.manifest.binary,
    built.command.entry,
  );
  if (shim === null) return built;
  return {
    ok: true,
    command: new PrintedCommand(GATE, [shim, ...words], platform, realpathOfExisting(shim) ?? shim),
    entryKind: 'shim',
  };
}

/**
 * This installation's stable launcher for `packageName`, when it starts that package at exactly `version`: the file is
 * there (executable, where it is a shell script), its pointer is one the launcher reads, and the runtime it names holds
 * the package at that version with a CLI the launcher can start. Null otherwise — a pointer that cannot be read too.
 */
function stableLauncher(
  dataDir: string,
  packageName: string,
  version: unknown,
  platform: NodeJS.Platform,
): string | null {
  if (typeof version !== 'string') return null;
  try {
    const name = launcherName(packageName);
    const { launcher } = launcherPaths(dataDir, name);
    if (!statSync(launcher).isFile()) return null;
    accessSync(launcher, platform === 'win32' ? constants.R_OK : constants.X_OK);
    const pointer = readPointerSync(dataDir, name);
    if (pointer === undefined || !launcherCanStartSync(pointer.current, name)) return null;
    const started = readPackageManifest(join(pointer.current, 'node_modules', ...packageName.split('/')));
    return started?.name === packageName && started.version === version ? launcher : null;
  } catch {
    return null;
  }
}

/**
 * The command a package declares for itself: a channel's in its `agentcomms` field, a service's in `agentcommsPackage`
 * (D14). A library declares none, and no package declares both: the registry refuses one that does.
 */
function declaredBinary(manifest: Record<string, unknown>): unknown {
  const channel = manifest.agentcomms;
  if (typeof channel === 'object' && channel !== null) return (channel as Record<string, unknown>).binary;
  const service = manifest.agentcommsPackage;
  if (typeof service === 'object' && service !== null && (service as Record<string, unknown>).kind === 'service') {
    return (service as Record<string, unknown>).binary;
  }
  return undefined;
}

/**
 * The target's package a registration's files lead to, or null: a script it starts, real or as written when it is
 * gone, inside the package (or inside the product's own server wrapper, which depends on it); or, for the product's
 * own command, the package that command links into or that npm installed beside it.
 */
function registeredPackage(
  files: { scripts: readonly string[]; command: string | null },
  target: CliCommandTarget,
  facts: RegistrationFacts,
): Found | null {
  for (const script of files.scripts) {
    if (!isAbsolute(script)) continue;
    const found = packageAround(script, target, facts);
    if (found !== null) {
      const source = join(found.root, 'src', 'cli.ts');
      const real = realpathOfExisting(script);
      return { ...found, source: real !== null && sameFile(real, source) };
    }
  }
  const { command } = files;
  if (command === null || !isAbsolute(command)) return null;
  const linked = packageAround(command, target, facts);
  if (linked !== null) return { ...linked, source: false };
  // npm's own layouts for a global command: beside it on Windows, in `../lib` of its prefix elsewhere.
  const dir = dirname(command);
  for (const candidate of [join(dir, 'node_modules'), join(dir, '..', 'lib', 'node_modules')]) {
    let root: string;
    try {
      root = realpathSync(join(candidate, ...target.packageName.split('/')));
    } catch {
      continue;
    }
    const manifest = readPackageManifest(root);
    if (manifest?.name === target.packageName) return { root, manifest, source: false };
  }
  return null;
}

/** The target's package that `file` is in — directly, or through the product's server wrapper, which depends on it. */
function packageAround(
  file: string,
  target: CliCommandTarget,
  facts: RegistrationFacts,
): { root: string; manifest: Record<string, unknown> } | null {
  const real = realpathOfExisting(file);
  if (real === null) return null;
  const nearest = nearestPackage(dirname(real));
  if (nearest === null || nearest.manifest === null) return null;
  let root: string;
  try {
    root = realpathSync(nearest.root);
  } catch {
    return null;
  }
  if (nearest.manifest.name === target.packageName) return { root, manifest: nearest.manifest };
  if (facts.npxPackage === target.packageName || nearest.manifest.name !== facts.npxPackage) return null;
  const installed = installedPackage(root, target.packageName);
  const manifest = installed === null ? null : readPackageManifest(installed);
  return installed !== null && manifest?.name === target.packageName ? { root: installed, manifest } : null;
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Two lists of words in order: the first that differs decides, and a list that runs out first comes first. */
function compareWords(a: readonly string[], b: readonly string[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const [x, y] = [a[index] as string, b[index] as string];
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/** Why no registration of another product could be used, in a clause: how many were looked at, and what each was. */
function notRegistered(notUsed: readonly RegistrationNotUsed[], version: string): string {
  if (notUsed.length === 0) return 'no MCP client on this machine has it registered';
  const said: Record<RegistrationRejection, string> = {
    npx: 'run by npx, which is never used for this',
    arguments: 'with a path option that has no value',
    'no-file': 'not started from a file named by its full path',
    'no-package': 'whose package cannot be found or read',
    version: 'of another or an unknown version',
    engine: 'whose Node range this Node is outside, or which declares none',
    bin: 'whose package does not name its command',
    entry: 'whose command file is missing, unreadable or outside its package',
  };
  const counts = new Map<RegistrationRejection, number>();
  for (const { why } of notUsed) counts.set(why, (counts.get(why) ?? 0) + 1);
  const parts = [...counts].map(([why, count]) => `${count} ${said[why]}`);
  const registered = notUsed.length === 1 ? 'the 1 registration' : `the ${notUsed.length} registrations`;
  return `none of ${registered} of it is ${version} in a file this can check (${parts.join('; ')})`;
}

function notLocated(
  target: CliCommandTarget,
  version: string,
  reason: CliNotLocatedReason,
  detail: string,
  nodeVersion: string,
  extra: { nodeRange?: string | undefined; registrations?: readonly RegistrationNotUsed[] },
): CliCommandNotLocated {
  const named = `${target.manifest.label} ${version} (${target.packageName})`;
  const { nodeRange, registrations } = extra;
  const message =
    nodeRange === undefined
      ? `${named} is not locatable here: ${detail}. Install or update it through your usual route, then try again.`
      : `${named} needs Node ${nodeRange}, and this is Node ${nodeVersion}, so there is no command to run it with here. Run it again under a Node in that range.`;
  const notLocated: CliCommandNotLocated = {
    ok: false as const,
    reason,
    product: target.manifest.label,
    package: target.packageName,
    version,
    ...(nodeRange === undefined ? {} : { nodeRange }),
    ...(registrations === undefined ? {} : { registrations: Object.freeze([...registrations]) }),
    detail,
    message,
  };
  // As JSON, in a result's field, the sentence saying why — the text the field always carried — and never interpolated:
  // as a printed command does (`PrintedCommand.toJSON`). Not enumerable, so the result's own fields are all there is.
  Object.defineProperties(notLocated, {
    toJSON: { value: () => message },
    [Symbol.toPrimitive]: {
      value: () => {
        throw new TypeError('a missing command is said with handoffText or handoffSentence, never interpolated');
      },
    },
  });
  return Object.freeze(notLocated);
}

/**
 * The entry's real path, when it is a readable regular file inside its package's real root by whole segments — as
 * written and after links are resolved — or why not.
 *
 * Checked now, for the command printed now (D6). This does not make the path durable: an npx cache evicted, a global
 * install upgraded in place or a file replaced after this is what the command meets when it runs — a missing file
 * fails with Node's own error naming it, a replaced one runs as it then is. Nothing here, or in the command, looks
 * anywhere else for the product, PATH included, and a later locate checks the path again.
 */
function checkedEntry(root: string, entry: string): { ok: true; path: string } | { ok: false; why: string } {
  if (!isWithin(root, entry)) return { ok: false, why: `${entry} is outside its package, ${root}` };
  let real: string;
  try {
    real = realpathSync(entry);
  } catch {
    return { ok: false, why: `${entry} is not there` };
  }
  if (!isWithin(root, real)) return { ok: false, why: `${entry} leads to ${real}, outside its package, ${root}` };
  try {
    if (!statSync(real).isFile()) return { ok: false, why: `${entry} is not a file` };
    accessSync(real, constants.R_OK);
  } catch {
    return { ok: false, why: `${entry} cannot be read` };
  }
  return { ok: true, path: real };
}

/**
 * The real root of the package `name` installed for a module in `start`, found as Node's own resolution finds one: in
 * `node_modules` of each directory from there up. Not resolved through its `exports` — core's point at a build, and
 * which entry to run is decided here — and never from a global folder, which `import` does not read either.
 */
function installedPackage(start: string, name: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (basename(dir) !== 'node_modules') {
      const candidate = join(dir, 'node_modules', ...name.split('/'));
      try {
        if (statSync(candidate).isDirectory()) return realpathSync(candidate);
      } catch {
        // not installed here
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The real repository checkout whose workspace lists `root` as one of its packages, or null: the nearest
 * `pnpm-workspace.yaml` above it, and its `packages` globs. A package under the checkout but not one of them — an
 * installed copy in its `node_modules` — is not a workspace package of it.
 */
function workspaceOf(root: string): string | null {
  let dir = dirname(root);
  for (;;) {
    const globs = workspaceGlobs(dir);
    if (globs !== null) return inWorkspace(relative(dir, root).split(sep), globs) ? dir : null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The `packages` globs of `dir/pnpm-workspace.yaml`, or null when there is no such file. */
function workspaceGlobs(dir: string): string[] | null {
  let text: string;
  try {
    text = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : [];
  }
  const unquote = (glob: string) => glob.trim().replace(/^(['"])(.*)\1$/, '$2');
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => /^packages\s*:/.test(line));
  if (at < 0) return [];
  const inline = /^packages\s*:\s*\[(.*)\]\s*(?:#.*)?$/.exec(lines[at] as string);
  if (inline) return (inline[1] ?? '').split(',').map(unquote).filter(Boolean);
  const globs: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const item = /^\s+-\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (!item) break;
    globs.push(unquote(item[1] ?? ''));
  }
  return globs;
}

/** Whether a path, as segments from the workspace root, is one of its packages: some glob takes it and no `!` one. */
function inWorkspace(segments: readonly string[], globs: readonly string[]): boolean {
  const matches = (glob: string) =>
    segmentsMatch(
      segments,
      glob
        .replace(/^\.\//, '')
        .replace(/\/+$/, '')
        .split('/')
        .filter((part) => part !== '.'),
    );
  const included = globs.filter((glob) => !glob.startsWith('!'));
  const excluded = globs.filter((glob) => glob.startsWith('!')).map((glob) => glob.slice(1));
  return included.some(matches) && !excluded.some(matches);
}

function segmentsMatch(path: readonly string[], pattern: readonly string[]): boolean {
  const [head, ...rest] = pattern;
  if (head === undefined) return path.length === 0;
  if (head === '**') return segmentsMatch(path, rest) || (path.length > 0 && segmentsMatch(path.slice(1), pattern));
  const [segment] = path;
  if (segment === undefined) return false;
  const glob = new RegExp(`^${head.split('*').map(escapeRegExp).join('[^/]*')}$`);
  return glob.test(segment) && segmentsMatch(path.slice(1), rest);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
