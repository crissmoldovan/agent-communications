import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { access, readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';
import { CommsError } from './errors.ts';
import { writeFileAtomic } from './fs.ts';
import { withFileLock } from './lock.ts';

/*
 * The stable launcher (design 2026-10-16, U6).
 *
 * A registration used to name a versioned runtime, `<data>/runtime/<version>-<name>/…/cli.mjs`, so every update had to
 * edit every client's configuration. Now a registration — and a managed CLI shim — starts `<data>/launch/<name>`,
 * which reads the pointer beside it, `<data>/launch/<name>.current`, and runs the CLI of the runtime that names, with
 * the Node it was written for. An update installs the new runtime beside the old one and switches the pointer, in one
 * rename; a running server keeps the code it started with, and no file of a runtime in use is ever changed.
 *
 * A pointer file, never a symbolic link, so Windows works without Developer Mode. It names runtimes by their folder in
 * `<data>/runtime` alone — `current=0.20.0-gmail`, and `previous=0.19.0-gmail` — so nothing in it is a path that a shell
 * or Windows could read otherwise, and nothing in it can point outside that folder.
 *
 * **A runtime that fails to start** is one whose CLI is not there to start: removed, half-installed, quarantined. The
 * launcher then starts the previous runtime instead, once, and records that beside the pointer (`readFallback`). It
 * never falls back from a runtime that did start: whatever that runtime then does — an approval, a send — has been
 * done, and running the previous runtime with the same words would do it twice. A runtime that cannot start for any
 * other reason is the update's to catch before it switches (its self-check), not the launcher's.
 *
 * On macOS and Linux the launcher is a POSIX shell script with nothing but the shell's own built-ins in it, so no
 * program is looked for on PATH. On Windows a `.cmd` file would make cmd.exe parse the words it forwards again
 * (design 2026-10-04, D8), and a client cannot start one without a shell, so the launcher there is a script that Node
 * runs: the registration starts the Node, the launcher is its first word, and it runs the runtime's CLI in that same
 * process. Nothing re-parses any word, on either.
 */

/** The scope every server package is published under; a launcher is named for the rest of the package name. */
const SCOPE = '@agentcomms';
const LAUNCH = 'launch';
const RUNTIMES = 'runtime';
const POINTER = '.current';
const FALLBACK = '.fallback';
const LOCK = '.lock';

/**
 * What a launcher hands the process it starts (re-review of 0.20.0, severity 6): its own name, so the process knows it
 * was started through its package's stable launcher — the one the background job switches — and not by npx, a
 * versioned or local registration, or a command from somewhere else. The update notice holds back only for such a
 * process what the job will install (`update-gate.ts`), and only a run of `update --background` started through the
 * core launcher, as the job starts it, records that the job ran (`update-background.ts`).
 */
export const LAUNCHER_ENV = 'AGENT_COMMS_LAUNCHER';

/** A launcher's name: one plain word, never a path — the unscoped name of a server package. */
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** A runtime's folder in `<data>/runtime`: no separator, nothing that starts with a dot. */
const FOLDER = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
/** The version a managed runtime's folder starts with, as `mcp prune` reads one. */
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/;

/** The CLI inside a runtime, as words from the runtime's folder: what `managedRuntimeEntry` names. */
function cliWords(name: string): string[] {
  return ['node_modules', SCOPE, name, 'dist', 'cli.mjs'];
}

/** What a pointer says: the runtime the launcher starts, and the one before it. Full paths, under `<data>/runtime`. */
export interface LauncherPointer {
  current: string;
  previous?: string;
}

/** What the launcher recorded when it last fell back: when, and from which runtime folder to which. */
export interface LauncherFallback {
  at: Date;
  from: string | null;
  to: string | null;
}

function checkedName(name: string): string {
  if (!NAME.test(name)) {
    throw new CommsError('CONFIG', `${JSON.stringify(name)} is not a launcher name: one plain word, such as gmail`);
  }
  return name;
}

/** The launcher a server package is started through: its name without the scope, `@agentcomms/gmail` → `gmail`. */
export function launcherName(packageName: string): string {
  const [scope, rest, extra] = packageName.split('/');
  if (scope !== SCOPE || rest === undefined || extra !== undefined) {
    throw new CommsError('CONFIG', `${packageName} is not a package a stable launcher starts`);
  }
  return checkedName(rest);
}

/** Where a launcher and its pointer are: `<data>/launch/<name>` and `<data>/launch/<name>.current`. */
export function launcherPaths(dataDir: string, name: string): { launcher: string; pointer: string } {
  const directory = join(dataDir, LAUNCH);
  checkedName(name);
  return { launcher: join(directory, name), pointer: join(directory, `${name}${POINTER}`) };
}

/** Where the launcher records that it fell back: `<data>/launch/<name>.fallback`. */
export function fallbackRecordPath(dataDir: string, name: string): string {
  return join(dataDir, LAUNCH, `${checkedName(name)}${FALLBACK}`);
}

/** The CLI a runtime holds for a launcher: `<runtime>/node_modules/@agentcomms/<name>/dist/cli.mjs`. */
export function launcherCli(runtimeDir: string, name: string): string {
  return join(runtimeDir, ...cliWords(checkedName(name)));
}

/** The version a runtime folder of this launcher is, `0.20.0` for `0.20.0-gmail`; null for any other folder. */
export function launcherRuntimeVersion(runtimeDir: string, name: string): string | null {
  const folder = basename(runtimeDir);
  const suffix = `-${checkedName(name)}`;
  if (!folder.endsWith(suffix)) return null;
  const version = folder.slice(0, -suffix.length);
  return VERSION.test(version) ? version : null;
}

/** A runtime folder this launcher may point at: a folder of its own in `<data>/runtime`, named for it. */
function isOwnFolder(folder: string, name: string): boolean {
  return FOLDER.test(folder) && folder.endsWith(`-${name}`) && folder.length > name.length + 1;
}

/** The pointer's text: one runtime folder a line, read by the launcher with nothing but its shell's built-ins. */
function pointerText(current: string, previous: string | undefined): string {
  return [
    '# The runtime the stable launcher beside this file starts, written by agent-communications. Do not edit.',
    `current=${current}`,
    ...(previous === undefined ? [] : [`previous=${previous}`]),
    '',
  ].join('\n');
}

/** The pointer in `text`, as runtime folders, or null when it is not one this writes. */
function parsePointer(text: string, name: string): { current: string; previous?: string } | null {
  let current: string | undefined;
  let previous: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    const key = at < 0 ? line : line.slice(0, at);
    const value = at < 0 ? '' : line.slice(at + 1);
    if (key === 'current' && current === undefined) current = value;
    else if (key === 'previous' && previous === undefined) previous = value;
    else return null;
  }
  if (current === undefined || !isOwnFolder(current, name)) return null;
  if (previous !== undefined && !isOwnFolder(previous, name)) return null;
  return previous === undefined ? { current } : { current, previous };
}

function asPaths(dataDir: string, folders: { current: string; previous?: string }): LauncherPointer {
  const runtimes = join(dataDir, RUNTIMES);
  return folders.previous === undefined
    ? { current: join(runtimes, folders.current) }
    : { current: join(runtimes, folders.current), previous: join(runtimes, folders.previous) };
}

function unreadable(pointer: string, why: string): CommsError {
  return new CommsError('CONFIG', `${pointer} cannot be read as a pointer: ${why}`, {
    hint: 'It is written by managed installs and updates, never by hand. Run a managed install or an update again: it writes the pointer afresh.',
  });
}

/** The pointer's runtime folders, or undefined when there is no pointer; refused when it is not one this writes. */
async function readFolders(dataDir: string, name: string): Promise<{ current: string; previous?: string } | undefined> {
  const { pointer } = launcherPaths(dataDir, name);
  let text: string;
  try {
    text = await readFile(pointer, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw unreadable(pointer, (error as NodeJS.ErrnoException).code ?? String(error));
  }
  const folders = parsePointer(text, name);
  if (folders === null)
    throw unreadable(pointer, `it does not name a runtime of ${name} in ${join(dataDir, RUNTIMES)}`);
  return folders;
}

/**
 * The runtime a launcher starts, and the one before it; undefined when it has no pointer yet.
 *
 * A pointer that is there and is not one this writes is refused rather than taken for none: what it names may be in
 * use, and "no pointer" would let a prune or an update act as though nothing were.
 */
export async function readPointer(dataDir: string, name: string): Promise<LauncherPointer | undefined> {
  const folders = await readFolders(dataDir, name);
  return folders === undefined ? undefined : asPaths(dataDir, folders);
}

/** `readPointer`, for a reader that cannot wait: the registration readers, which the command locator calls. */
export function readPointerSync(dataDir: string, name: string): LauncherPointer | undefined {
  const { pointer } = launcherPaths(dataDir, name);
  let text: string;
  try {
    text = readFileSync(pointer, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw unreadable(pointer, (error as NodeJS.ErrnoException).code ?? String(error));
  }
  const folders = parsePointer(text, name);
  if (folders === null)
    throw unreadable(pointer, `it does not name a runtime of ${name} in ${join(dataDir, RUNTIMES)}`);
  return asPaths(dataDir, folders);
}

/** Whether the CLI a runtime holds for this launcher is a file that can be read: whether the launcher can start it. */
export async function launcherCanStart(runtimeDir: string, name: string): Promise<boolean> {
  const cli = launcherCli(runtimeDir, name);
  try {
    if (!(await stat(cli)).isFile()) return false;
    await access(cli, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** `launcherCanStart`, for a reader that cannot wait. */
export function launcherCanStartSync(runtimeDir: string, name: string): boolean {
  const cli = launcherCli(runtimeDir, name);
  try {
    if (!statSync(cli).isFile()) return false;
    accessSync(cli, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** The folder of a runtime this launcher may be switched to, or why not. Nothing outside `<data>/runtime` is one. */
async function switchableFolder(dataDir: string, name: string, runtimeDir: string): Promise<string> {
  const folder = basename(runtimeDir);
  const own = resolve(dirname(runtimeDir)) === resolve(join(dataDir, RUNTIMES)) && isOwnFolder(folder, name);
  if (!own) {
    throw new CommsError(
      'CONFIG',
      `${runtimeDir} is not a runtime of ${name} in ${join(dataDir, RUNTIMES)}, so the launcher was not switched to it`,
    );
  }
  if (!(await launcherCanStart(runtimeDir, name))) {
    throw new CommsError(
      'CONFIG',
      `${runtimeDir} has no CLI to start at ${launcherCli(runtimeDir, name)}, so the launcher was not switched to it`,
      { hint: 'Install that runtime again: a managed install or an update puts its CLI in place.' },
    );
  }
  return folder;
}

/** One change of a pointer at a time, across every process of this installation. */
function withPointerLock<T>(dataDir: string, name: string, change: () => Promise<T>): Promise<T> {
  return withFileLock(join(dataDir, LAUNCH, `${checkedName(name)}${LOCK}`), change, {
    timeoutMs: 10_000,
    staleMs: 30_000,
  });
}

/**
 * Points the launcher at `runtimeDir`, and returns the pointer it replaced (undefined when there was none).
 *
 * `switchPointer` without the answer; exported for an install or an update that may have to put it back
 * (`restorePointer`) and must know exactly what it was.
 */
export async function exchangePointer(
  dataDir: string,
  name: string,
  runtimeDir: string,
): Promise<LauncherPointer | undefined> {
  const folder = await switchableFolder(dataDir, name, runtimeDir);
  return withPointerLock(dataDir, name, async () => {
    // One that cannot be read is replaced: this is the write that repairs it, and nothing in it can be kept.
    const before = await readFolders(dataDir, name).catch(() => undefined);
    if (before?.current === folder) return asPaths(dataDir, before);
    await writeFileAtomic(launcherPaths(dataDir, name).pointer, pointerText(folder, before?.current));
    return before === undefined ? undefined : asPaths(dataDir, before);
  });
}

/**
 * Points the launcher at `runtimeDir`: a temporary file, then one rename over the pointer, so a launcher starting at
 * any moment reads the old pointer or the new, whole. The runtime it pointed at before becomes `previous`, for a fall
 * back and a rollback; switching to the runtime it already points at changes nothing, `previous` included.
 *
 * Refused, changing nothing, unless `runtimeDir` is a runtime of this launcher in `<data>/runtime` with its CLI in
 * place. No file of either runtime is touched.
 */
export async function switchPointer(dataDir: string, name: string, runtimeDir: string): Promise<void> {
  await exchangePointer(dataDir, name, runtimeDir);
}

/**
 * Puts back the pointer a switch replaced (`exchangePointer`'s answer; undefined removes the pointer), only while the
 * pointer still names `expected` — what that switch pointed it at. Anything else means something switched it since,
 * and that newer pointer stays. Says whether it put it back.
 */
export async function restorePointer(
  dataDir: string,
  name: string,
  before: LauncherPointer | undefined,
  expected: string,
): Promise<boolean> {
  return withPointerLock(dataDir, name, async () => {
    const now = await readFolders(dataDir, name).catch(() => undefined);
    if (now === undefined || now.current !== basename(expected)) return false;
    const { pointer } = launcherPaths(dataDir, name);
    if (before === undefined) await rm(pointer, { force: true });
    else {
      await writeFileAtomic(
        pointer,
        pointerText(basename(before.current), before.previous === undefined ? undefined : basename(before.previous)),
      );
    }
    return true;
  });
}

/**
 * Switches the launcher back to its previous runtime, and the one it leaves becomes `previous`: a second rollback goes
 * forward again. Refused, changing nothing, when there is no pointer, no previous runtime, a previous runtime whose CLI
 * is no longer there, or — with `expect` — a pointer that no longer names that runtime as current.
 */
export async function rollbackPointer(
  dataDir: string,
  name: string,
  options: { expect?: string | undefined } = {},
): Promise<{ from: string; to: string }> {
  return withPointerLock(dataDir, name, async () => {
    const now = await readFolders(dataDir, name);
    if (now === undefined) {
      throw new CommsError('CONFIG', `the ${name} launcher has no pointer, so there is nothing to roll back`);
    }
    const paths = asPaths(dataDir, now);
    if (now.previous === undefined || paths.previous === undefined) {
      throw new CommsError('CONFIG', `the ${name} launcher has no previous runtime to roll back to`);
    }
    if (options.expect !== undefined && resolve(options.expect) !== resolve(paths.current)) {
      throw new CommsError(
        'CONFIG',
        `the ${name} launcher now starts ${paths.current}, not ${options.expect}, so it was not rolled back`,
      );
    }
    if (!(await launcherCanStart(paths.previous, name))) {
      throw new CommsError(
        'CONFIG',
        `${paths.previous} has no CLI to start at ${launcherCli(paths.previous, name)}, so the ${name} launcher was not rolled back to it`,
      );
    }
    await writeFileAtomic(launcherPaths(dataDir, name).pointer, pointerText(now.previous, now.current));
    return { from: paths.current, to: paths.previous };
  });
}

/** What the launcher recorded when it last fell back, or undefined when it never has: when, from and to. */
export async function readFallback(dataDir: string, name: string): Promise<LauncherFallback | undefined> {
  const path = fallbackRecordPath(dataDir, name);
  let text: string;
  let at: Date;
  try {
    [text, at] = await Promise.all([readFile(path, 'utf8'), stat(path).then((info) => info.mtime)]);
  } catch {
    return undefined;
  }
  // Written by a shell with no clock but the file's own: when it was written is when it fell back.
  const field = (key: string) => {
    const value = new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1];
    return value !== undefined && FOLDER.test(value) ? value : null;
  };
  return { at, from: field('from'), to: field('to') };
}

function posixWord(word: string): string {
  return `'${word.replaceAll("'", `'"'"'`)}'`;
}

/** The launcher for macOS and Linux: the shell's built-ins only, so nothing is looked for on PATH. */
function posixSource(dataDir: string, name: string, node: string): string {
  const runtimes = join(dataDir, RUNTIMES);
  const { pointer } = launcherPaths(dataDir, name);
  const record = fallbackRecordPath(dataDir, name);
  return `#!/bin/sh
# The stable launcher of agent-communications for ${name}, format 1. Written by managed installs and updates; do not edit.
# It starts the runtime the pointer beside it names, with the Node below. When that runtime's CLI is not there to
# start, it starts the previous runtime instead, once, and records that beside the pointer. It never falls back from a
# runtime that started, and never writes to stdout: an MCP client speaks there.
node=${posixWord(node)}
runtimes=${posixWord(runtimes)}
pointer=${posixWord(pointer)}
record=${posixWord(record)}
cli=${posixWord(cliWords(name).join('/'))}
suffix=${posixWord(`-${name}`)}
${LAUNCHER_ENV}=${posixWord(name)}
export ${LAUNCHER_ENV}
current=
previous=
if [ -f "$pointer" ] && [ -r "$pointer" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      current=*) [ -z "$current" ] && current=\${line#current=} ;;
      previous=*) [ -z "$previous" ] && previous=\${line#previous=} ;;
    esac
  done < "$pointer"
fi
startable() {
  case $1 in
    ''|.*|*[!0-9A-Za-z.+_-]*) return 1 ;;
  esac
  case $1 in
    *"$suffix") ;;
    *) return 1 ;;
  esac
  [ "$1" != "$suffix" ] && [ -f "$runtimes/$1/$cli" ] && [ -r "$runtimes/$1/$cli" ]
}
if startable "$current"; then
  exec "$node" "$runtimes/$current/$cli" "$@"
fi
if [ "$previous" != "$current" ] && startable "$previous"; then
  { printf 'from=%s\\n' "$current"; printf 'to=%s\\n' "$previous"; } 2>/dev/null > "$record"
  exec "$node" "$runtimes/$previous/$cli" "$@"
fi
printf '%s\\n' "agent-communications: the ${name} launcher has no runtime it can start: its pointer, $pointer, names \${current:-none}, and the runtime before it \${previous:-none}, and neither CLI is in $runtimes. A managed install or an update puts one in place." >&2
exit 78
`;
}

/**
 * The launcher for Windows: a CommonJS script Node runs — the registration starts the Node, and this is its first word —
 * which runs the runtime's CLI in the same process, so nothing re-parses the words and no second process is left behind
 * when the client stops the server. `argv[1]` is set to that CLI, as though Node had been started on it.
 */
function windowsSource(dataDir: string, name: string, node: string): string {
  const runtimes = join(dataDir, RUNTIMES);
  const { pointer } = launcherPaths(dataDir, name);
  const record = fallbackRecordPath(dataDir, name);
  const json = JSON.stringify;
  return `// The stable launcher of agent-communications for ${name}, format 1, for Windows. Written by managed installs and
// updates; do not edit. Started by ${json(node)} with this file as its first word: it starts the runtime the pointer
// beside it names, in this process. When that runtime's CLI is not there to start, it starts the previous runtime
// instead, once, and records that beside the pointer. It never falls back from a runtime that started.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const runtimes = ${json(runtimes)};
const pointer = ${json(pointer)};
const record = ${json(record)};
const cli = ${json(cliWords(name))};
const suffix = ${json(`-${name}`)};
let current = '';
let previous = '';
try {
  for (const line of fs.readFileSync(pointer, 'utf8').split(/\\r?\\n/)) {
    if (line.startsWith('current=') && current === '') current = line.slice(8);
    else if (line.startsWith('previous=') && previous === '') previous = line.slice(9);
  }
} catch {}
function startable(folder) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(folder) || !folder.endsWith(suffix) || folder === suffix) return null;
  const entry = path.join(runtimes, folder, ...cli);
  try {
    if (!fs.statSync(entry).isFile()) return null;
    fs.accessSync(entry, fs.constants.R_OK);
    return entry;
  } catch {
    return null;
  }
}
let entry = startable(current);
if (entry === null && previous !== current) {
  entry = startable(previous);
  if (entry !== null) {
    try {
      const temp = record + '.' + process.pid + '.tmp';
      fs.writeFileSync(temp, 'from=' + current + '\\nto=' + previous + '\\n');
      fs.renameSync(temp, record);
    } catch {}
  }
}
if (entry === null) {
  process.stderr.write('agent-communications: the ' + ${json(name)} + ' launcher has no runtime it can start: its pointer, ' + pointer + ', names ' + (current || 'none') + ', and the runtime before it ' + (previous || 'none') + ', and neither CLI is in ' + runtimes + '. A managed install or an update puts one in place.\\n');
  process.exit(78);
}
process.argv[1] = entry;
process.env.${LAUNCHER_ENV} = ${json(name)};
import(pathToFileURL(entry).href).catch((error) => {
  process.exitCode = 1;
  console.error(error);
});
`;
}

/**
 * Writes the launcher `<data>/launch/<name>`: a temporary file, then a rename, so a launcher starting meanwhile runs
 * the old one or the new, whole. It starts the runtime its pointer names with `node` — given as the registration and
 * the shim name it, a link left a link (CUE-492) — and falls back once to `previous` when that runtime cannot start
 * (see the top of this module).
 *
 * POSIX: a shell script, executable by its owner alone. Windows (`platform`): a script for Node, with a `package.json`
 * beside it saying it is CommonJS, whatever a folder above the data directory says; the registration starts `node`.
 */
export async function writeLauncher(
  dataDir: string,
  name: string,
  node: string,
  options: { platform?: NodeJS.Platform | undefined } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const { launcher } = launcherPaths(dataDir, name);
  const absolute = platform === 'win32' ? win32.isAbsolute(node) : posix.isAbsolute(node);
  if (!absolute) {
    throw new CommsError('CONFIG', `the launcher's Node has to be named by its full path, not ${JSON.stringify(node)}`);
  }
  const data = resolve(dataDir);
  if (platform === 'win32') {
    await writeFileAtomic(join(dirname(launcher), 'package.json'), `${JSON.stringify({ type: 'commonjs' })}\n`);
    await writeFileAtomic(launcher, windowsSource(data, name, node));
    return;
  }
  await writeFileAtomic(launcher, posixSource(data, name, node), 0o700);
}

/** Whether the launcher file is there. */
export async function launcherExists(dataDir: string, name: string): Promise<boolean> {
  try {
    return (await stat(launcherPaths(dataDir, name).launcher)).isFile();
  } catch {
    return false;
  }
}

/** The `--data-dir` a registration pins, in either form, before any `--`. */
function dataDirPin(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] as string;
    if (word === '--') return undefined;
    if (word === '--data-dir') return args[index + 1] === '--' ? undefined : args[index + 1] || undefined;
    if (word.startsWith('--data-dir=')) return word.slice('--data-dir='.length) || undefined;
  }
  return undefined;
}

/** A path as words to compare: separators made one, a trailing one dropped, without case on Windows. */
function comparable(path: string, platform: NodeJS.Platform | undefined): string {
  const plain = path.replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '');
  return platform === 'win32' ? plain.toLowerCase() : plain;
}

/**
 * The stable launcher a registered entry starts, read from its own words, or null when it starts none.
 *
 * Ours only when the launcher is in the very data directory the entry itself pins with `--data-dir` — the program on
 * POSIX, the first word after Node on Windows (`platform`) — named like one: a program called `launch/gmail` anywhere
 * else is somebody else's. Nothing is read from disk.
 */
export function registeredLauncher(
  server: { readonly command: string; readonly args: readonly string[] },
  platform?: NodeJS.Platform,
): { dataDir: string; name: string; launcher: string } | null {
  const dataDir = dataDirPin(server.args);
  if (dataDir === undefined) return null;
  const directory = `${comparable(dataDir, platform)}/${LAUNCH}`;
  for (const candidate of [server.command, server.args[0]]) {
    if (candidate === undefined) continue;
    const words = comparable(candidate, platform);
    if (!words.startsWith(`${directory}/`)) continue;
    const name = candidate.split(/[\\/]+/).at(-1) ?? '';
    if (words !== `${directory}/${comparable(name, platform)}` || !NAME.test(name)) continue;
    return { dataDir, name, launcher: candidate };
  }
  return null;
}
