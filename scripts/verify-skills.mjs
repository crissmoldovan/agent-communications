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
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { REGISTRY } from './channels.mjs';

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
  // Cargo's build output for the desktop app: gigabytes of generated files, never source.
  'target',
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

/** Every file under `directory`, depth-first. One shared list, never a spread: a tree can hold any number of files. */
function walk(directory, entries = []) {
  if (!existsSync(directory)) return entries;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) walk(path, entries);
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

/** Event services may declare a request-only skill family without entering any channel-only registry view. */
function serviceOf(family) {
  return REGISTRY.services.find((service) => service.directory === family.package);
}

function escaped(text) {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

function eventServiceRows(family) {
  const capabilityPath = resolve(root, 'capabilities.json');
  let capabilities;
  try {
    capabilities = JSON.parse(readFileSync(capabilityPath, 'utf8')).capabilities;
  } catch (error) {
    fail(`capabilities.json: cannot read event skill safety surface: ${error.message}`);
    return null;
  }
  if (!Array.isArray(capabilities)) {
    fail('capabilities.json: event skill safety surface has no capabilities array');
    return null;
  }
  return capabilities.filter((row) => row?.package === family.package);
}

function unsafeSecretInstruction(source) {
  const action =
    /\b(?:ask|request|read|type|relay|paste|provide|collect|share|enter)\w*\b[^.\n]{0,100}\b(?:secret|token|password|key|credential)\b/i;
  const denial =
    /\b(?:never|do not|don't|must not|cannot)\b[^.\n]{0,100}\b(?:ask|request|read|type|relay|paste|provide|collect|share|enter)\w*\b/i;
  return source.split('\n').find((line) => action.test(line) && !denial.test(line));
}

function validateEventServiceSkill(service, rows, file, source) {
  const where = show(file);
  const name = service.declaration.server.defaultName;
  // Markdown wraps prose, while the safety promises are semantic sentences rather than line-oriented syntax.
  const prose = source.replace(/\s+/g, ' ');
  const requiredTools = [
    `${name}_catalogue_list`,
    `${name}_sources_list`,
    `${name}_rule_create`,
    `${name}_rule_test`,
    `${name}_rule_enable`,
    `${name}_approval_view`,
  ];
  if (!source.includes('## Safe workflow') || requiredTools.some((tool) => !source.includes(`\`${tool}\``))) {
    fail(`${where}: event service skill is missing the safe workflow`);
  }
  if (
    !prose.includes('`plain` leaves each sanitised string as it is; `enveloped` wraps each untrusted string.') ||
    !prose.includes('sanitised and enveloped regardless of the target representation')
  ) {
    fail(`${where}: event service skill must explain plain and enveloped output`);
  }
  if (!source.includes('Every judge kind is off until a person enables it.')) {
    fail(`${where}: event service skill must say every judge kind is off`);
  }
  if (
    !source.includes('## Approval handoff') ||
    !source.includes('Give the approval id and preview to\nthe person.') ||
    !source.includes(
      'Standing disclosure can be approved only by a person typing the challenge at an interactive terminal.',
    )
  ) {
    fail(`${where}: event service skill is missing the approval handoff`);
  }

  // The handoffs come from the capability rows, so a new or reworded human-only row cannot leave the skill behind.
  // A human-only exception's reason names the person; the process entry points (`run`, the server) name none.
  const humanOnlyHandoffs = [
    ...new Set(
      rows
        .filter((row) => row.status === 'exception' && row.mcp === null && /\bperson\b/i.test(row.reason ?? ''))
        .map((row) => row.reason),
    ),
  ];
  if (humanOnlyHandoffs.length === 0) fail(`${where}: the event service declares no human-only exception rows`);
  for (const handoff of humanOnlyHandoffs) {
    if (!prose.includes(handoff))
      fail(`${where}: event service skill is missing the exact human-only handoff: ${handoff}`);
  }

  const secret = unsafeSecretInstruction(source);
  if (secret !== undefined)
    fail(`${where}: event service skill contains a secret-request instruction: ${secret.trim()}`);

  const allowedTools = new Set(rows.map((row) => row.mcp).filter((tool) => typeof tool === 'string'));
  const toolPattern = new RegExp(`\\b${escaped(name)}_[a-z][a-z0-9_]*\\b`, 'g');
  for (const [tool] of source.matchAll(toolPattern)) {
    if (!allowedTools.has(tool)) fail(`${where}: ${tool} is not a registered MCP tool`);
  }

  const binary = service.declaration.binary;
  for (const row of rows) {
    if (row.status !== 'exception' || row.mcp !== null || typeof row.cli !== 'string') continue;
    const command = `${binary} ${row.cli}`;
    const instruction = new RegExp(`\\b(?:run|call|invoke|use|execute)\\s+\`?${escaped(command)}\\b`, 'i');
    if (instruction.test(source)) fail(`${where}: event service skill instructs a model to use human-only ${command}`);
  }
}

const serviceFamilies = REGISTRY.skillFamilies.filter((family) => family.kind === 'service');
for (const family of serviceFamilies) {
  const service = serviceOf(family);
  if (!service) {
    fail(`skills/${family.prefix}*: service skill family has no declared service`);
    continue;
  }
  const files = skillFiles.filter((file) => basename(dirname(file)).startsWith(family.prefix));
  if (files.length === 0) {
    fail(`skills/${family.prefix}*: no skill belongs to declared service family ${family.prefix}`);
    continue;
  }
  const rows = eventServiceRows(family);
  if (rows === null) continue;
  const name = service.declaration.server.defaultName;
  const tools = new Set(rows.map((row) => row.mcp));
  if (!tools.has(`${name}_rule_test`) || !tools.has(`${name}_judge_kinds_list`)) continue;
  for (const file of files) validateEventServiceSkill(service, rows, file, readFileSync(file, 'utf8'));
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
/*
 * The positions an account's name is written in. Gmail names one with `--inbox`, Slack with `--workspace`, and every
 * channel after them with `--account` — which the channel contract made the pin for all of them — so `account` is a
 * position everywhere `inbox` and `workspace` are. Resend manages its accounts with `account add` and the like;
 * WhatsApp's `add` and `remove` take the name straight after the binary, so the binaries come from the registry.
 */
const HOLDERS = '(?:inbox|workspace|account)';
const MANAGE = '(?:add|remove|reauth|finish|show|policy)';
const BINARIES = REGISTRY.channels
  .map(({ manifest }) => manifest.binary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const ANYWHERE = [
  new RegExp(String.raw`--${HOLDERS}[ =](${ALIAS})(?![\w/-])`, 'g'),
  new RegExp(String.raw`["']?\b${HOLDERS}["']?: ?["'](${ALIAS})["']`, 'g'),
  new RegExp(String.raw`\binbox-(${ALIAS})\.md`, 'g'),
  // A correct download path has two segments — `…/acme/gmail/exports/…` — so a first segment followed by a
  // platform is the organisation, not a flat name.
  // The platforms are the channels' own words, from the registry, so a new channel's paths are read the same way.
  new RegExp(String.raw`agent-communications/(${ALIAS})/(?!(?:${REGISTRY.platforms.join('|')})(?:-[a-z0-9-]+)?/)`, 'g'),
];
const IN_CODE = [
  new RegExp(String.raw`\b${HOLDERS} ${MANAGE} (${ALIAS})(?![\w/-])`, 'g'),
  new RegExp(String.raw`\b(?:${BINARIES}) (?:add|remove) (${ALIAS})(?![\w/-])`, 'g'),
  new RegExp(String.raw`\b${HOLDERS} (${ALIAS}) ·`, 'g'),
  new RegExp(String.raw`\bin ["“](${ALIAS})["”]`, 'g'),
  // A trailing `· something` is not a position: in these documents it is as often a message id as a name.
];

/*
 * The same positions holding a qualified name, `organisation/platform` — or a placeholder for the organisation — so
 * that a channel's skills can be held to naming that channel's accounts.
 */
const QUALIFIED = String.raw`((?:<[^>\s]+>|[a-z0-9][a-z0-9._-]*)/([a-z0-9][a-z0-9-]*))(?![\w/-])`;
const QUALIFIED_ANYWHERE = [
  new RegExp(`--${HOLDERS}[ =]${QUALIFIED}`, 'g'),
  new RegExp(String.raw`["']?\b${HOLDERS}["']?: ?["']${QUALIFIED}["']`, 'g'),
];
const QUALIFIED_IN_CODE = [
  new RegExp(String.raw`\b${HOLDERS} ${MANAGE} ${QUALIFIED}`, 'g'),
  new RegExp(String.raw`\b(?:${BINARIES}) (?:add|remove) ${QUALIFIED}`, 'g'),
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

/*
 * A channel's skills name that channel's accounts.
 *
 * `agent-resend domains --account acme/gmail` is a command Resend refuses, and nothing read it: the check above only
 * asks whether a name is qualified. So every file of a channel's skill family — each `skills/<prefix>*` directory and
 * the family's contract in `skills/_shared/` — is held to that channel's platform word, from the registry, optionally
 * with a suffix (`acme/gmail-tech`). The core's `comms-` skills manage every channel and may name any of them.
 */
for (const family of REGISTRY.skillFamilies) {
  if (!REGISTRY.platforms.includes(family.channel)) continue;
  const files = [resolve(root, family.contract)];
  for (const entry of existsSync(skillsRoot) ? readdirSync(skillsRoot, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || !entry.name.startsWith(family.prefix)) continue;
    files.push(...walk(resolve(skillsRoot, entry.name)));
  }
  for (const file of files) {
    if (!file.endsWith('.md') || !existsSync(file)) continue;
    const source = readFileSync(file, 'utf8');
    const searched = [
      [source, QUALIFIED_ANYWHERE],
      [codeOf(source), QUALIFIED_IN_CODE],
    ];
    const foreign = new Set();
    for (const [text, patterns] of searched) {
      for (const pattern of patterns) {
        for (const [, name, platform] of text.matchAll(pattern)) {
          if (platform !== family.channel && !platform.startsWith(`${family.channel}-`)) foreign.add(name);
        }
      }
    }
    for (const name of foreign) {
      fail(
        `${show(file)}: "${name}" is not a ${family.channel} account; a ${family.family} skill names ` +
          `<organisation>/${family.channel}`,
      );
    }
  }
}

if (failures.length) {
  console.error(`Skill verification failed (${failures.length} issue${failures.length === 1 ? '' : 's'}):`);
  for (const message of failures) console.error(`- ${message}`);
  process.exitCode = 1;
} else {
  console.log(`Skill verification passed: ${skillFiles.length} skill${skillFiles.length === 1 ? '' : 's'} discovered.`);
}
