#!/usr/bin/env node
/**
 * Validate the public skill catalog without external dependencies.
 *
 * Ported from crissmoldovan/agent-skills and extended for a repository that handles Google OAuth material:
 * - the secret scan also recognises JSON-shaped credentials (`"client_secret": "…"`, `"refresh_token": "…"`)
 *   and Google token prefixes, which the original pattern misses because of the quote between key and colon;
 * - `metadata` must be a YAML map, because Codex refuses to load a skill whose `metadata` is a string;
 * - no directory is exempt from the whole-tree scan.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

const root = process.cwd();
const skillsRoot = resolve(root, 'skills');
const failures = [];
const textExtensions = new Set(['.md', '.mdx', '.txt', '.json', '.yml', '.yaml', '.js', '.mjs', '.cjs', '.ts']);
// A SKILL.md body — everything after the frontmatter — is capped so that detail lives in
// carried reference files instead of the always-loaded instruction file.
const MAX_BODY_LINES = 484;
// The portable Agent Skills contract's own frontmatter limits, in characters. Other channels
// enforce them — the private catalogue's build refused a 523-character compatibility — so a
// skill that passes here has to pass there too.
const FIELD_LIMITS = { name: 64, description: 1024, compatibility: 500 };
// Any bare references/, scripts/, or assets/ token in a skill's prose is read as a promise
// that the skill carries that exact file. Prose that means "reference files, or scripts"
// must not be written as a path.
const CARRIED_FILE_PATTERN = /(?:^|[^A-Za-z0-9._/-])((?:references|scripts|assets)\/[A-Za-z0-9._/-]+)/g;
// Every skill declares WHERE IT FITS, in a form a script can evaluate, so that onboard-project
// can recommend it from evidence rather than from a description a matcher happened to like.
// `signals` is evaluated against a repository; `general` fits nearly any repository; `requestOnly`
// is never recommended by a scan. A skill with no fit.json is invisible to that scan, which is a
// silent failure — hence a loud one here.
const FIT_KINDS = new Set(['signals', 'general', 'requestOnly']);
const ignoredDirectories = new Set([
  '.git',
  '.cache',
  '.next',
  '.superpowers',
  '.tmp',
  '.turbo',
  '.vite',
  '.wrangler',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'tmp',
]);
// Values that are obviously placeholders, so fixtures and docs can show the shape of a credential.
const PLACEHOLDER = String.raw`(?:not-a-real-secret|example(?:[-_][a-z0-9]+)*|test(?:[-_][a-z0-9]+)*|fake(?:[-_][a-z0-9]+)*|your[-_](?:token|secret|key)[-_]here|changeme|<[^>'"]+>|\$\{[^}'"]+\})`;
const SECRET_PATTERNS = [
  // PEM private keys.
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/,
  // `token = "…"`, `secret: '…'` and similar unquoted-key assignments.
  new RegExp(String.raw`(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"](?!${PLACEHOLDER}['"])[^'"\s]{8,}['"]`, 'i'),
  // JSON-shaped credentials: the quote between key and colon defeats the pattern above.
  new RegExp(
    String.raw`"(?:client_secret|refresh_token|access_token|id_token|api[_-]?key|secret|token|password)"\s*:\s*"(?!${PLACEHOLDER}")[^"\s]{8,}"`,
    'i',
  ),
  // Google: OAuth client secrets, access tokens, refresh tokens, API keys.
  /GOCSPX-[A-Za-z0-9_-]{20,}/,
  /ya29\.[A-Za-z0-9_-]{20,}/,
  /1\/\/0[A-Za-z0-9_-]{30,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  // GitHub and OpenAI-style tokens.
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
];

/** Paths in messages always use forward slashes, so output reads the same on every platform. */
function show(path) {
  return relative(root, path).split(sep).join('/');
}

function fail(message) {
  failures.push(message);
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  const entries = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) entries.push(...walk(path));
    else if (entry.isFile()) entries.push(path);
  }
  return entries;
}

function isWithin(candidate, container) {
  const path = relative(container, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.includes(`${sep}..${sep}`));
}

function parseFrontmatter(source, file) {
  if (!source.startsWith('---\n')) {
    fail(`${show(file)}: SKILL.md must start with YAML frontmatter`);
    return null;
  }
  const close = source.indexOf('\n---\n', 4);
  if (close < 0) {
    fail(`${show(file)}: frontmatter must close with ---`);
    return null;
  }
  const frontmatter = source.slice(4, close);
  const result = Object.create(null);
  // The catalog deliberately accepts YAML maps, lists, and folded scalars.
  // The scalar keys checked here are extracted without introducing a YAML dependency.
  for (const key of Object.keys(FIELD_LIMITS)) {
    const value = scalar(frontmatter, key);
    if (value !== undefined) result[key] = value;
  }
  result.metadataError = metadataProblem(frontmatter);
  return result;
}

/** `metadata`, when present, must be a map of string values. Codex refuses a skill whose `metadata` is a single
 *  string ("expected struct SkillFrontmatterMetadata"); an unquoted number or boolean is not a string either. */
function metadataProblem(frontmatter) {
  const lines = frontmatter.split('\n');
  const index = lines.findIndex((line) => line.startsWith('metadata:'));
  if (index < 0) return undefined;
  const inline = lines[index].slice('metadata:'.length).trim();
  if (inline !== '') return 'metadata must be a YAML map of strings, not an inline value (Codex rejects a string)';
  let entries = 0;
  for (const line of lines.slice(index + 1)) {
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) break;
    const entry = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!entry) return `metadata entry is not a key: value pair: ${line.trim()}`;
    const value = entry[2].trim();
    if (value === '' || /^[[{|>]/.test(value)) return `metadata.${entry[1]} must be a plain string value`;
    if (
      /^(?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|true|false|yes|no|on|off|null|~|\.inf|\.nan)$/i.test(
        value,
      )
    ) {
      return `metadata.${entry[1]} must be quoted: ${value} is not read as a string`;
    }
    entries += 1;
  }
  return entries === 0 ? 'metadata is empty' : undefined;
}

/** A top-level scalar: inline (quotes stripped), or a block scalar (`>`, `|`) read from its
 *  indented lines — folded with spaces, or kept with newlines — so its length is the length
 *  of the value a reader gets, not of the marker. */
function scalar(frontmatter, key) {
  const lines = frontmatter.split('\n');
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index < 0) return undefined;
  const inline = lines[index].slice(key.length + 1).trim();
  if (!/^[>|][+-]?$/.test(inline)) return inline.replace(/^(['"])(.*)\1$/, '$2') || undefined;
  const block = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    block.push(line.trim());
  }
  return block.join(inline.startsWith('>') ? ' ' : '\n').trim();
}

function bodyLineCount(source) {
  if (!source.startsWith('---\n')) return source.split('\n').length;
  const close = source.indexOf('\n---\n', 4);
  if (close < 0) return source.split('\n').length;
  const body = source.slice(close + 5);
  if (body === '') return 0;
  return body.split('\n').length - (body.endsWith('\n') ? 1 : 0);
}

// Bare tokens are resolved against the skill directory, which is the form the authoring
// rule prescribes; markdown links are separately resolved against their containing file.
function validateCarriedFiles(source, file, skillDirectory) {
  for (const match of source.matchAll(CARRIED_FILE_PATTERN)) {
    const token = match[1].replace(/[.,;:)\]]+$/, '');
    if (!existsSync(resolve(skillDirectory, token))) {
      fail(`${show(file)}: names a carried file the skill does not carry: ${token}`);
    }
  }
}

/** `references/fit.json`: present, parseable, and one of the three kinds. */
function validateFit(skillDirectory, file) {
  const fitPath = resolve(skillDirectory, 'references', 'fit.json');
  const where = show(file);
  if (!existsSync(fitPath)) {
    fail(`${where}: no references/fit.json — declare where this skill fits (kinds: ${[...FIT_KINDS].join(', ')})`);
    return;
  }
  let fit;
  try {
    fit = JSON.parse(readFileSync(fitPath, 'utf8'));
  } catch (error) {
    fail(`${where}: references/fit.json does not parse: ${error.message}`);
    return;
  }
  if (!fit || typeof fit !== 'object' || Array.isArray(fit)) {
    fail(`${where}: references/fit.json must be a JSON object`);
    return;
  }
  if (!FIT_KINDS.has(fit.kind)) {
    fail(`${where}: references/fit.json kind must be one of ${[...FIT_KINDS].join(', ')}`);
    return;
  }
  if (typeof fit.useWhen !== 'string' || fit.useWhen.trim() === '') {
    fail(`${where}: references/fit.json needs a useWhen line — it is what the generated routing file says`);
  }
  if (fit.kind !== 'signals') return;
  const list = Array.isArray(fit.anyOf) ? fit.anyOf : Array.isArray(fit.allOf) ? fit.allOf : null;
  if (!list || list.length === 0) {
    fail(`${where}: references/fit.json kind "signals" needs a non-empty anyOf or allOf`);
    return;
  }
  for (const signal of list) {
    const repo = signal?.repo;
    const history = signal?.history;
    const readable =
      (repo && (repo.exists || repo.missing || repo.grep || repo.json || repo.toml || repo.yaml)) || history?.count;
    if (!readable)
      fail(`${where}: references/fit.json carries a signal this catalogue cannot read: ${JSON.stringify(signal)}`);
  }
}

function validateLinks(source, file, skillDirectory) {
  const markdownLink = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+['"][^)]*['"])?\)/g;
  for (const match of source.matchAll(markdownLink)) {
    const target = match[1].replace(/^<|>$/g, '');
    if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const pathname = target.split('#', 1)[0].split('?', 1)[0];
    if (!pathname) continue;
    const resolved = resolve(dirname(file), pathname);
    if (!isWithin(resolved, skillDirectory)) {
      fail(`${show(file)}: local link escapes its skill directory: ${target}`);
    } else if (!existsSync(resolved)) {
      fail(`${show(file)}: local link does not resolve: ${target}`);
    }
  }
}

const rootSkill = resolve(root, 'SKILL.md');
if (existsSync(rootSkill)) fail('SKILL.md at repository root is forbidden; use skills/<name>/SKILL.md');

const skillFiles = walk(skillsRoot).filter((file) => file.endsWith(`${sep}SKILL.md`));
const readmePath = resolve(root, 'README.md');
const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : null;
for (const file of skillFiles) {
  const skillDirectory = dirname(file);
  const expectedDirectory = resolve(skillsRoot, relative(skillsRoot, skillDirectory).split(sep)[0]);
  if (skillDirectory !== expectedDirectory) {
    fail(`${show(file)}: skill must be exactly skills/<name>/SKILL.md`);
    continue;
  }
  const name = relative(skillsRoot, skillDirectory);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    fail(`${show(file)}: skill directory name must use lowercase letters, digits, and single hyphens`);
  }
  const source = readFileSync(file, 'utf8');
  const frontmatter = parseFrontmatter(source, file);
  if (frontmatter) {
    if (!frontmatter.name) fail(`${show(file)}: missing frontmatter name`);
    else if (frontmatter.name !== name) fail(`${show(file)}: frontmatter name must match directory (${name})`);
    if (!frontmatter.description) fail(`${show(file)}: missing frontmatter description`);
    else if (readme !== null && !readme.includes(frontmatter.description))
      fail(`${show(file)}: README must list the exact frontmatter description`);
    if (frontmatter.metadataError) fail(`${show(file)}: ${frontmatter.metadataError}`);
    for (const [key, limit] of Object.entries(FIELD_LIMITS)) {
      const length = [...(frontmatter[key] ?? '')].length;
      if (length > limit) fail(`${show(file)}: ${key} is ${length} characters; the portable spec allows ${limit}`);
    }
  }
  const bodyLines = bodyLineCount(source);
  if (bodyLines > MAX_BODY_LINES) {
    fail(
      `${show(file)}: body is ${bodyLines} lines; the cap is ${MAX_BODY_LINES} — move detail into carried reference files`,
    );
  }
  validateFit(skillDirectory, file);
  validateLinks(source, file, skillDirectory);
  for (const carried of walk(skillDirectory)) {
    const extension = carried.slice(carried.lastIndexOf('.')).toLowerCase();
    if (!['.md', '.mdx', '.txt'].includes(extension)) continue;
    validateCarriedFiles(readFileSync(carried, 'utf8'), carried, skillDirectory);
  }
}

for (const file of walk(root)) {
  const relativeFile = show(file);
  if (relativeFile.split('/').includes('.git') || relativeFile.startsWith('node_modules')) continue;
  const extension = relativeFile.slice(relativeFile.lastIndexOf('.')).toLowerCase();
  if (!textExtensions.has(extension) && !['README', 'LICENSE', 'CONTRIBUTING', 'SECURITY'].includes(relativeFile))
    continue;
  const source = readFileSync(file, 'utf8');
  if (SECRET_PATTERNS.some((pattern) => pattern.test(source))) fail(`${relativeFile}: contains a likely secret`);
  const absolutePath = /(?:^|[\s'"`(])(?:\/Users\/|\/home\/|C:\\Users\\)[^\s'"`)]+/m;
  if (absolutePath.test(source)) fail(`${relativeFile}: contains a machine-specific absolute path`);
}

/*
 * Account names in the material people copy from.
 *
 * Every account is `organisation/platform` now, and a config created today refuses anything else — so an example
 * that still says `--inbox work` is a command that cannot work, and one a reader will copy before they find out.
 *
 * Only name positions are looked at, because most of these words are ordinary English everywhere else: `archive`
 * is an action, `personal` is an adjective, and `work` is what the software does. The positions split in two.
 * Some are unambiguous wherever they appear — a flag, a JSON field, a profile file name, a path under the
 * downloads root. The rest are subcommands, whose grammar prose imitates exactly ("inbox add and reauth",
 * "inbox add failed"), so those are read only inside code — a fenced block or a backticked span.
 *
 * A version-1 alias is what it always was, digits and all, so the grammar here is that one rather than a guess at
 * which words looked like names.
 *
 * Historical material is exempt: a spec records what was decided at the time, a research note what was observed,
 * and the changelog what the old names were.
 */
const ALIAS = String.raw`[a-z0-9][a-z0-9-]{0,31}`;
const ANYWHERE = [
  new RegExp(String.raw`--(?:inbox|workspace)[ =](${ALIAS})(?![\w/-])`, 'g'),
  new RegExp(String.raw`["']?\b(?:inbox|workspace)["']?: ?["'](${ALIAS})["']`, 'g'),
  new RegExp(String.raw`\binbox-(${ALIAS})\.md`, 'g'),
  // A correct download path has two segments — `…/acme/gmail/exports/…` — so a first segment followed by a
  // platform is the organisation, not a flat name.
  new RegExp(String.raw`agent-communications/(${ALIAS})/(?!(?:gmail|slack)(?:-[a-z0-9-]+)?/)`, 'g'),
];
const IN_CODE = [
  new RegExp(String.raw`\b(?:inbox|workspace) (?:add|remove|reauth|finish) (${ALIAS})(?![\w/-])`, 'g'),
  new RegExp(String.raw`\b(?:inbox|workspace) (${ALIAS}) ·`, 'g'),
  new RegExp(String.raw`\bin ["“](${ALIAS})["”]`, 'g'),
  // A trailing `· something` is not a position: in these documents it is as often a message id as a name.
];
/**
 * The parts of a document a reader copies rather than reads.
 *
 * Enough of CommonMark to be honest about what it covers, and it covers what these documents actually contain:
 *
 * - fences of three or more backticks or tildes, at any indentation, closed by the same character at the same
 *   length or longer, or by the end of the file — including one opened on a list-item line (`- ```sh`) and one
 *   indented inside a list;
 * - indented blocks, but only where one can start: after a blank line, and not as a list item's own continuation,
 *   which is indented the same way and is prose. A blank line inside one does not end it;
 * - inline spans of any delimiter length, which may cross a line but not a blank line.
 *
 * What is *not* code matters as much as what is. Prose imitates subcommand grammar exactly — "inbox add and
 * reauth", "inbox add failed" — and a check that flags English is a check somebody turns off.
 */
function codeOf(source) {
  const code = [];
  const prose = [];
  let fence = null;
  let blankBefore = true;
  let indented = false;
  let listBefore = false;
  for (const line of source.split('\n')) {
    if (fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      else code.push(line);
      continue;
    }
    // A fence may open on the same line as the list marker that introduces it.
    const open = /^\s*(`{3,}|~{3,})(.*)$/.exec(line.replace(/^(\s*)(?:[-*+]|\d{1,9}[.)])\s+/, '$1'));
    // An info string may not contain a backtick, which is what tells ```` ``` ```` quoted in prose from a fence.
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = open[1];
      blankBefore = false;
      indented = false;
      continue;
    }
    const blank = line.trim() === '';
    if (/^ {4,}\S/.test(line) && (indented || (blankBefore && !listBefore))) {
      code.push(line);
      indented = true;
    } else {
      if (!blank) indented = false;
      prose.push(line);
    }
    if (!blank) listBefore = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s/.test(line) || (listBefore && /^ {2,}\S/.test(line));
    blankBefore = blank;
  }
  // A code span may run over a line break but not over a blank line, so each paragraph is scanned on its own.
  for (const paragraph of prose.join('\n').split(/\n[ \t]*\n/)) {
    for (const [, , span] of paragraph.matchAll(/(`+)((?:[^`]|(?!\1)`)+)\1(?!`)/g)) code.push(span);
  }
  return code.join('\n');
}
const userFacing = (relativeFile) =>
  (relativeFile.startsWith('skills/') ||
    relativeFile.startsWith('docs/') ||
    relativeFile === 'README.md' ||
    /^packages\/[^/]+\/README\.md$/.test(relativeFile)) &&
  !relativeFile.startsWith('docs/superpowers/') &&
  !relativeFile.startsWith('docs/research/');

for (const file of walk(root)) {
  const relativeFile = show(file);
  if (!userFacing(relativeFile) || !relativeFile.endsWith('.md')) continue;
  const source = readFileSync(file, 'utf8');
  const searched = [
    [source, ANYWHERE],
    [codeOf(source), IN_CODE],
  ];
  const flat = new Set();
  for (const [text, patterns] of searched) {
    for (const pattern of patterns) {
      for (const [, name] of text.matchAll(pattern)) if (name) flat.add(name);
    }
  }
  for (const name of flat) {
    fail(`${relativeFile}: "${name}" is a flat account name; every account is organisation/platform`);
  }
}

if (failures.length) {
  console.error(`Skill verification failed (${failures.length} issue${failures.length === 1 ? '' : 's'}):`);
  for (const message of failures) console.error(`- ${message}`);
  process.exitCode = 1;
} else {
  console.log(`Skill verification passed: ${skillFiles.length} skill${skillFiles.length === 1 ? '' : 's'} discovered.`);
}
