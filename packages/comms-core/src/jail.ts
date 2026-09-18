import { constants } from 'node:fs';
import { type FileHandle, open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDangerous } from './chars.ts';
import { CommsError } from './errors.ts';
import { expandHome } from './paths.ts';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
// Path separators, C0 control characters, DEL, and characters Windows refuses in file names.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what this strips
const UNSAFE_FILENAME_CHARS = /[/\\\u0000-\u001f\u007f<>:"|?*]/g;

/** Truncates a string to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateBytes(value: string, maxBytes: number): string {
  let out = '';
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

/**
 * A file name that is safe to create on macOS, Linux and Windows: NFC-normalised, no separators or control
 * characters, no leading or trailing dots and spaces, not a Windows reserved device name, at most `maxBytes` UTF-8
 * bytes with the extension kept. Never empty.
 */
export function safeFilename(name: string, maxBytes = 255, fallback = 'attachment'): string {
  // Invisible and bidi characters go first: `invoice<RLO>fdp.exe` is displayed as `invoiceexe.pdf` by file managers
  // and mail clients, which is how an executable is opened by someone who thought they were opening a PDF.
  const visible = [...name.normalize('NFC')]
    .filter((character) => !isDangerous(character.codePointAt(0) ?? 0))
    .join('');
  let cleaned = visible.replace(UNSAFE_FILENAME_CHARS, '_').replace(/\s+/g, ' ');
  cleaned = cleaned.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (cleaned === '') cleaned = fallback;
  const extension = extname(cleaned);
  const stem = extension ? cleaned.slice(0, -extension.length) : cleaned;
  if (WINDOWS_RESERVED.test(stem)) cleaned = `_${cleaned}`;
  if (Buffer.byteLength(cleaned, 'utf8') <= maxBytes) return cleaned;
  const keptExtension = Buffer.byteLength(extension, 'utf8') < maxBytes / 2 ? extension : '';
  const keptStem = keptExtension ? cleaned.slice(0, -keptExtension.length) : cleaned;
  return truncateBytes(keptStem, maxBytes - Buffer.byteLength(keptExtension, 'utf8')) + keptExtension;
}

/** A short lowercase slug for directory names: letters and digits joined by single hyphens. */
export function slug(text: string, maxLength = 40, fallback = 'untitled'): string {
  const value = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return value || fallback;
}

/** True when `candidate` is `root` itself or strictly inside it (lexically). */
export function isInside(candidate: string, root: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

async function realpathOfExistingAncestor(path: string): Promise<string> {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch (error) {
      const parent = dirname(current);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) throw error;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves `target` for writing and proves it stays inside `root` after symlinks in its existing ancestors are
 * followed. Throws BAD_DATA otherwise. The root must already exist.
 */
export async function resolveInsideRoot(root: string, target: string): Promise<string> {
  const realRoot = await realpath(root);
  const lexical = resolve(root, target);
  if (!isInside(lexical, root)) {
    throw new CommsError('BAD_DATA', `refusing to write outside ${root}`, { details: { target } });
  }
  const real = await realpathOfExistingAncestor(lexical);
  if (!isInside(real, realRoot)) {
    throw new CommsError('BAD_DATA', `refusing to write through a link that leaves ${root}`, { details: { target } });
  }
  return lexical;
}

/**
 * Creates a new file for writing without following a symlink at the final component and without overwriting an
 * existing file. Picks `name-2.ext`, `name-3.ext`… when the name is taken.
 */
export async function createUniqueFile(
  directory: string,
  filename: string,
): Promise<{ path: string; handle: FileHandle }> {
  const extension = extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const name = attempt === 1 ? filename : `${stem}-${attempt}${extension}`;
    const path = join(directory, name);
    try {
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      return { path, handle };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new CommsError('BAD_DATA', `could not find a free file name for ${filename} in ${directory}`);
}

/**
 * Default places attachments may never be read from, whatever the allowed roots say. `~/.*` means every dot-entry
 * directly under home — SSH, cloud, npm, git and shell credentials, agent configs; `**∕.git/**` any repository's git
 * directory; `**∕.env*` dotenv files anywhere.
 */
export function defaultAttachDeny(configDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const deny = [configDir, '~/.*', '~/Library', '**/.git/**', '**/.env*'];
  if (env.APPDATA) deny.push(env.APPDATA);
  if (env.LOCALAPPDATA) deny.push(env.LOCALAPPDATA);
  return deny;
}

export interface AttachPolicy {
  roots: string[];
  deny: string[];
  home?: string;
}

async function realOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Proves a local file may be attached to a draft: it resolves (following links) to a regular file inside one of the
 * allowed roots and inside none of the deny entries. A deny entry of the form `**` + `/name*` matches by file name
 * prefix (so `.env*` matches `.env` and `.env.local`). Returns the real path.
 */
export async function checkAttachable(path: string, policy: AttachPolicy): Promise<string> {
  const home = policy.home;
  const requested = resolve(expandHome(path, home));
  let real: string;
  try {
    real = await realpath(requested);
  } catch {
    throw new CommsError('NOT_FOUND', `attachment not found: ${path}`);
  }
  const info = await stat(real);
  if (!info.isFile()) throw new CommsError('BAD_DATA', `not a regular file: ${path}`);

  const roots = await Promise.all(policy.roots.map((root) => realOrResolved(expandHome(root, home))));
  if (!roots.some((root) => isInside(real, root))) {
    throw new CommsError('BAD_DATA', `attachments must come from an allowed folder; ${path} is outside them`, {
      hint: 'Move the file into an allowed folder, or add its folder to defaults.attachRoots with the CLI.',
    });
  }
  const name = basename(real);
  const homeDir = await realOrResolved(home ?? (await import('node:os')).homedir());
  for (const entry of policy.deny) {
    if (entry === '~/.*') {
      if (isInside(real, homeDir)) {
        const first = relative(homeDir, real).split(sep)[0] ?? '';
        if (first.startsWith('.')) {
          throw new CommsError(
            'BAD_DATA',
            `refusing to attach a file from ~/${first}: hidden folders in your home are never attached`,
          );
        }
      }
      continue;
    }
    if (entry === '**/.git/**') {
      if (real.split(sep).some((segment) => segment.toLowerCase() === '.git'))
        throw new CommsError('BAD_DATA', 'refusing to attach a file from a .git folder');
      continue;
    }
    if (entry.startsWith('**/')) {
      const pattern = entry.slice(3);
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      if (pattern.endsWith('*') ? name.startsWith(prefix) : name === prefix) {
        throw new CommsError('BAD_DATA', `refusing to attach ${name}: files matching ${entry} are never attached`);
      }
      continue;
    }
    const denied = await realOrResolved(expandHome(entry, home));
    if (isInside(real, denied)) {
      throw new CommsError('BAD_DATA', `refusing to attach a file from ${entry}`);
    }
  }
  return real;
}
