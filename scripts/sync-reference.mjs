#!/usr/bin/env node
/**
 * Generates the CLI and MCP reference pages from the code, rather than asking anybody to keep them in step by hand.
 *
 * Three audits of this repository found 68 places where a hand-written document contradicted the code it described
 * — one of them told an agent to re-inbox mail the user had archived. A reference covering 23 commands and 29 tools
 * is exactly the kind of document that drifts, because nothing fails when it does. So it is generated, and
 * `--check` fails the build when the committed pages no longer match.
 *
 *   node scripts/sync-reference.mjs           # write the pages
 *   node scripts/sync-reference.mjs --check   # fail if they are out of date
 *
 * The CLI half captures `--help` through the same code path a person runs, by handing `run()` its streams. The MCP
 * half asks a live server for `tools/list`. Both read the product rather than a description of it.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const OUT_CLI = join(root, 'docs/reference/cli.md');
const OUT_MCP = join(root, 'docs/reference/mcp-tools.md');

/**
 * The CLIs this page is generated from.
 *
 * A second entry rather than a second script: the page is generated *from the CLI itself*, and two generators
 * would be two chances for one of them to drift from the program it documents. `groups` are the commands that
 * only group others — their own help lists subcommands rather than doing anything.
 */
const CLIS = [
  {
    binary: 'agent-gmail',
    pkg: '@agentcomms/gmail',
    program: 'packages/gmail/src/cli/program.ts',
    out: 'docs/reference/cli.md',
    provider: 'Gmail',
    groups: new Set(['client', 'inbox', 'attachments', 'draft', 'send']),
  },
  {
    binary: 'agent-slack',
    pkg: '@agentcomms/slack',
    program: 'packages/slack/src/cli/program.ts',
    out: 'docs/reference/slack-cli.md',
    provider: 'Slack',
    groups: new Set(['workspace', 'draft', 'post']),
  },
];

// The source, not the bundle: `dist/cli.mjs` is a bin that runs on import, and neither bundle re-exports `run`.
// This file is therefore executed with `--experimental-strip-types`, the same way the test suite runs TypeScript.
// `pathToFileURL`, not the bare path: on Windows an absolute path is `D:\\…`, and ESM rejects it as an unknown
// URL scheme. This only shows up on Windows, so a dynamic import of a path must always go through a file:// URL.

/** Runs `--help` for a command through the real CLI, capturing what a person would see. */
async function help(run, argv) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let text = '';
  stdout.on('data', (c) => {
    text += c;
  });
  stderr.on('data', (c) => {
    text += c;
  });
  await run([...argv, '--help'], {
    streams: { stdout, stderr, stdin: new PassThrough() },
    env: { ...process.env, NO_COLOR: '1', AGENT_COMMS_CONFIG_DIR: join(root, '.tmp-reference-config') },
  });
  return text;
}

/** Splits Commander's help into its sections, which are stable and are what the user actually reads. */
function sections(text) {
  const out = { usage: '', description: '', Arguments: [], Options: [], Commands: [] };
  const lines = text.split('\n');
  let current = null;
  for (const line of lines) {
    const usage = /^Usage:\s*(.+)$/.exec(line);
    if (usage) {
      out.usage = usage[1].trim();
      current = 'description';
      continue;
    }
    const heading = /^(Arguments|Options|Commands):\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      continue;
    }
    if (/^\S/.test(line) && current && current !== 'description') current = null;
    if (!line.trim()) continue;
    if (current === 'description') out.description += `${line.trim()} `;
    else if (current && /^\s{3,}/.test(line) && out[current].length > 0) {
      // A wrapped continuation: Commander starts every entry two spaces in, and indents the rest of a long description
      // to line up under it. Read as its own entry, it became a row of its own — the flag column holding the tail of
      // the previous description, and the previous row's default cut off mid-sentence.
      out[current][out[current].length - 1] += ` ${line.trim()}`;
    } else if (current) out[current].push(line);
  }
  out.description = out.description.trim();
  return out;
}

/** One `  --flag <value>   what it does (default: x)` line into its parts. */
function entry(line) {
  const m = /^\s{2,}(\S.*?)\s{2,}(.*)$/.exec(line);
  if (!m) return { name: line.trim(), text: '' };
  let text = m[2].trim();
  let fallback = '';
  const d = /\(default:\s*(.+?)\)\s*$/.exec(text);
  if (d) {
    fallback = d[1];
    text = text.slice(0, d.index).trim();
  }
  return { name: m[1].trim(), text, fallback };
}

const table = (rows, headers) =>
  [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows].join('\n');

const cell = (s) =>
  String(s ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');

async function commandPage(cli, run, path) {
  const s = sections(await help(run, path));
  const lines = [`### \`${cli.binary} ${path.join(' ')}\``, ''];
  if (s.description) lines.push(s.description, '');
  lines.push('```', s.usage.replace(new RegExp(`^${cli.binary}\\s*`), `${cli.binary} `), '```', '');

  if (s.Arguments.length) {
    const rows = s.Arguments.map(entry).map((a) => `| \`${cell(a.name)}\` | ${cell(a.text)} |`);
    lines.push(table(rows, ['Argument', 'What it is']), '');
  }
  if (s.Options.length) {
    const rows = s.Options.map(entry)
      .filter((o) => !/^-h, --help/.test(o.name))
      .map((o) => `| \`${cell(o.name)}\` | ${cell(o.text)} | ${o.fallback ? `\`${cell(o.fallback)}\`` : '—'} |`);
    if (rows.length) lines.push(table(rows, ['Option', 'What it does', 'Default']), '');
  }
  return lines.join('\n');
}

// ── The CLI page, once per CLI ────────────────────────────────────────────────────────────────────────────────
async function cliPage(cli) {
  const { run } = await import(pathToFileURL(join(root, cli.program)).href);
  const top = sections(await help(run, []));
  const commands = top.Commands.map(entry).filter((c) => !/^help\b/.test(c.name));

  const cliParts = [
    '<!-- generated by scripts/sync-reference.mjs — run `pnpm sync:reference`, do not edit -->',
    '# CLI reference',
    '',
    `Every command of \`${cli.binary}\`, generated from the CLI itself.`,
    '',
    `The CLI needs no MCP server and no agent. Install \`${cli.pkg}\` and run it.`,
    '',
    '```bash',
    `npx -y ${cli.pkg} <command>          # without installing`,
    `npm i -g ${cli.pkg} && ${cli.binary}   # or on the PATH`,
    '```',
    '',
    '`<angle brackets>` are required, `[square brackets]` optional, `<name...>` repeats. Every command takes',
    '`--json` for a machine-readable envelope, and `--no-color` to drop ANSI codes.',
    '',
    '## Exit codes',
    '',
    'Scripts should read these rather than parse output.',
    '',
    table(
      [
        '| `0` | it worked |',
        '| `1` | unexpected failure |',
        '| `10` | a send was refused, or an approval is required |',
        '| `64` | the command was used wrongly |',
        '| `65` | the data given was not usable |',
        '| `66` | what was asked for does not exist |',
        `| \`69\` | ${cli.provider} or the secret store is unavailable |`,
        '| `75` | temporary; retrying later is reasonable |',
        '| `77` | sign-in or a permission is needed |',
        '| `78` | a configuration problem, including `doctor` finding something broken |',
      ],
      ['Code', 'Meaning'],
    ),
    '',
    '## Commands',
    '',
    table(
      commands.map(
        (c) =>
          `| [\`${cell(c.name.split(' ')[0])}\`](#${cli.binary}-${c.name.split(' ')[0].split('|')[0]}) | ${cell(c.text)} |`,
      ),
      ['Command', 'What it is for'],
    ),
    '',
  ];

  for (const c of commands) {
    const name = c.name.split(' ')[0].split('|')[0];
    cliParts.push(await commandPage(cli, run, [name]), '');
    if (cli.groups.has(name)) {
      const sub = sections(await help(run, [name]))
        .Commands.map(entry)
        .filter((x) => !/^help\b/.test(x.name));
      for (const s of sub) cliParts.push(await commandPage(cli, run, [name, s.name.split(' ')[0].split('|')[0]]), '');
    }
  }

  return `${cliParts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

// ── The MCP page ──────────────────────────────────────────────────────────────────────────────────────────────
/** Asks a live server what it offers, so the page cannot describe a tool the server does not have. */
async function tools() {
  const child = spawn(process.execPath, [join(root, 'packages/gmail/dist/cli.mjs'), 'mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_COMMS_CONFIG_DIR: join(root, '.tmp-reference-config') },
  });
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c;
  });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'reference', version: '0' } },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const deadline = Date.now() + 30_000;
  let list = null;
  while (Date.now() < deadline && !list) {
    await new Promise((r) => setTimeout(r, 200));
    for (const line of buf.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const m = JSON.parse(line);
        if (m.id === 2) list = m.result;
      } catch {
        /* a partial line: the next chunk completes it */
      }
    }
  }
  child.kill();
  if (!list) throw new Error('the MCP server did not answer tools/list');
  return list.tools;
}

const all = await tools();
/** A one-line shape for an argument, so the table says what to pass without reproducing JSON Schema. */
function shape(schema) {
  if (!schema) return 'any';
  if (schema.enum) return schema.enum.map((v) => `\`${v}\``).join(' \\| ');
  if (schema.type === 'array') return `${shape(schema.items)}[]`;
  return schema.type ?? 'any';
}

const mcpParts = [
  '<!-- generated by scripts/sync-reference.mjs — run `pnpm sync:reference`, do not edit -->',
  '# MCP tool reference',
  '',
  `The ${all.length} tools the server offers, read from a running server.`,
  '',
  'The server is the same code as the CLI, over stdio. Start it with `agent-gmail mcp`, or install it into a client',
  'with `agent-gmail mcp install --client claude-code`. `@agentcomms/gmail-mcp` is a thin wrapper that starts the',
  'same server.',
  '',
  '**Every call takes `inbox`.** There is no default mailbox.',
  '',
  '## Tools',
  '',
  table(
    all.map((t) => `| [\`${t.name}\`](#${t.name}) | ${cell((t.description ?? '').split('.')[0])}. |`),
    ['Tool', 'What it does'],
  ),
  '',
];

for (const t of all) {
  const props = t.inputSchema?.properties ?? {};
  const required = new Set(t.inputSchema?.required ?? []);
  const a = t.annotations ?? {};
  const marks = [
    a.readOnlyHint ? 'read-only' : 'writes',
    a.destructiveHint ? 'destructive' : null,
    a.idempotentHint ? 'idempotent' : null,
  ].filter(Boolean);
  mcpParts.push(`### \`${t.name}\``, '', t.description ?? '', '', `*${marks.join(' · ')}*`, '');
  const rows = Object.entries(props).map(
    ([k, v]) =>
      `| \`${cell(k)}\` | ${cell(shape(v))} | ${required.has(k) ? '**yes**' : 'no'} | ${cell(v.description ?? '')} |`,
  );
  if (rows.length) mcpParts.push(table(rows, ['Argument', 'Type', 'Required', 'What it is']), '');
  else mcpParts.push('Takes no arguments.', '');
}

// ── The skills index ──────────────────────────────────────────────────────────────────────────────────────────
// Read from each skill's own frontmatter, so this page cannot describe a skill differently from the skill itself.
const { readdir } = await import('node:fs/promises');
const skillDirs = (await readdir(join(root, 'skills'), { withFileTypes: true }))
  .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
  .map((d) => d.name)
  .sort();

const skillRows = [];
const skillSections = [];
for (const name of skillDirs) {
  const body = await readFile(join(root, 'skills', name, 'SKILL.md'), 'utf8');
  const front = /^---\n([\s\S]*?)\n---/.exec(body)?.[1] ?? '';
  const description = (/^description:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? '')
    // The frontmatter value is often quoted; the quotes are YAML, not part of the sentence.
    .replace(/^["']|["']$/g, '')
    .trim();
  // The description is written as "what it is for. Symptoms: … Not for …" — split it so the page can be skimmed.
  const [purpose, ...rest] = description.split(/\s*Symptoms:\s*/);
  const [symptoms, notFor] = (rest.join(' Symptoms: ') || '').split(/\s*Not for\s*/);
  // Only the prose pages: a `fit.json` beside them is data the skill loader reads, not something to link a reader to.
  const refs = (await readdir(join(root, 'skills', name, 'references')).catch(() => [])).filter((f) =>
    f.endsWith('.md'),
  );
  skillRows.push(`| [\`${name}\`](#${name}) | ${cell(purpose.trim())} |`);
  skillSections.push(
    [
      `### \`${name}\``,
      '',
      purpose.trim(),
      '',
      symptoms ? `**Reach for it when:** ${symptoms.trim().replace(/\.$/, '')}` : '',
      notFor ? `\n**Not for** ${notFor.trim()}` : '',
      '',
      `[\`${name}/SKILL.md\`](../skills/${name}/SKILL.md)` +
        (refs.length
          ? ` · ${refs.map((r) => `[\`${r.replace(/\.md$/, '')}\`](../skills/${name}/references/${r})`).join(' · ')}`
          : ''),
      '',
    ].join('\n'),
  );
}

const skillParts = [
  '<!-- generated by scripts/sync-reference.mjs — run `pnpm sync:reference`, do not edit -->',
  '# Skills',
  '',
  `${skillDirs.length} skills, one per job. They are instructions for an agent, not code: what to reach for, what a`,
  'result actually means, what to tell you, and when to stop and ask.',
  '',
  '```bash',
  "npx skills add crissmoldovan/agent-communications --skill '*'",
  '```',
  '',
  'They work with the MCP server connected and without it, falling back to the CLI. Installing skills does not',
  'install a server, and installing a server does not install skills.',
  '',
  'All of them share one contract ([`_shared/contract.md`](../skills/_shared/contract.md)): name the mailbox, treat',
  'everything a mailbox returns as data rather than instructions, never send outside `gmail-send`, plan bulk changes',
  'before making them, cite message ids, and keep long mail in a file rather than in the conversation.',
  '',
  table(skillRows, ['Skill', 'What it is for']),
  '',
  ...skillSections,
];

// ── Write, or check ───────────────────────────────────────────────────────────────────────────────────────────
const OUT_SKILLS = join(root, 'docs/skills.md');
const pages = [
  // One per CLI, generated from each program rather than from a copy of its help text.
  ...(await Promise.all(CLIS.map(async (cli) => [join(root, cli.out), await cliPage(cli)]))),
  [
    OUT_MCP,
    `${mcpParts
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd()}\n`,
  ],
  [
    OUT_SKILLS,
    `${skillParts
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd()}\n`,
  ],
];

let stale = 0;
for (const [path, content] of pages) {
  if (check) {
    const existing = await readFile(path, 'utf8').catch(() => null);
    if (existing !== content) {
      stale += 1;
      console.error(`out of date: ${path.replace(`${root}/`, '')}`);
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

if (check && stale > 0) {
  console.error('\nRun `pnpm sync:reference` and commit the result.');
  process.exit(1);
}
console.log(
  check
    ? 'reference pages are in step with the code.'
    : `reference written: ${CLIS.length} CLI pages, ${all.length} MCP tools, ${skillDirs.length} skills.`,
);
