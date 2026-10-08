import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { REGISTRY } from '../scripts/channels.mjs';
import { PUBLISHABLE } from '../scripts/packages.mjs';

/**
 * What the documents tell a person to run to register, re-register and tidy up the MCP server, against what the
 * CLIs do.
 *
 * Each of these was wrong in a way nothing else caught, because the code they describe had changed under them and
 * had its own tests. The plugin's description said `npx -y @agentcomms/slack mcp install`, which has needed
 * `--client` since the CLIs stopped writing into a client nobody named: exit 64 on the first thing a new user
 * runs. The troubleshooting page offered `mcp install --list`, a flag that never existed, and a `jq` filter on
 * `.name`, a field no check has. Its "re-register" commands, and the setup skill's fix for `mcp-command`, are
 * refused for an entry that is already there unless they carry `--force`. And four pages promised `mcp prune`
 * never removes a runtime "any client registers", which is more than any config scan can see.
 *
 * `docs/reference` is left out because it is generated from the CLIs themselves, and the design specs and the
 * changelog because they record what was true when they were written.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);

async function markdownUnder(directory) {
  const found = [];
  for (const entry of await readdir(join(ROOT, directory), { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) found.push(join(entry.parentPath, entry.name));
  }
  return found;
}

async function documents() {
  const files = [
    ...(await markdownUnder('docs')).filter((path) => !/[/\\](?:reference|superpowers)[/\\]/.test(path)),
    ...(await markdownUnder('skills')),
    join(ROOT, 'README.md'),
    // Every publishable package's README, from the registry, held ones too: a new package's is checked from its first
    // commit, not from the release that lifts its hold.
    ...PUBLISHABLE.map((name) => join(ROOT, 'packages', name, 'README.md')),
    join(ROOT, '.claude-plugin', 'marketplace.json'),
    join(ROOT, 'gemini-extension.json'),
  ];
  return Promise.all(files.map(async (path) => ({ path: relative(ROOT, path), text: await readFile(path, 'utf8') })));
}

test('every declared CLI/MCP surface has generated reference destinations', () => {
  for (const surface of REGISTRY.surfaces) {
    const reference = REGISTRY.reference[surface.package];
    assert.ok(reference?.mcp, `${surface.package}: MCP reference is missing`);
    if (surface.cli === 'commander') assert.ok(reference?.cli, `${surface.package}: CLI reference is missing`);
  }
});

test('the held local event service README states B1’s foreground, platform, runtime, and read boundary', async () => {
  const readme = await readFile(join(ROOT, 'packages', 'events-daemon', 'README.md'), 'utf8');
  const prose = readme.replace(/\s+/g, ' ');
  assert.match(prose, /foreground owner only/i);
  assert.match(prose, /macOS and Linux only/i);
  assert.match(prose, /Windows refuses/i);
  assert.match(prose, /Node 22\.16(?:\.0)? or newer/i);
  assert.match(prose, /only the local .*dry-run target/i);
  assert.match(prose, /reads are terminal-only/i);
  assert.match(prose, /held from publication/i);
});

/**
 * Every `mcp install` a document gives, with the CLI it belongs to and the flags it passes.
 *
 * The core's too: `agentcomms mcp install` is the one registration that has to come from a terminal, so it is the
 * first command a person copies from the README.
 */
function installCommands(text) {
  const found = [];
  for (const [command, binary, tail] of text.matchAll(INSTALL)) {
    const words = (tail.split('#')[0] ?? '').trim().split(/\s+/).filter(Boolean);
    found.push({
      command: command.trim(),
      cli: channelOf(binary),
      flags: words.filter((word) => word.startsWith('--')),
    });
  }
  return found;
}

const escapeRegExp = (text) => text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

/**
 * How each channel's `mcp install` is spelled in a document — by its binary, or by its package through `npx` — read
 * from the channel registry, so a new channel's install commands are checked like the others'.
 */
const SPELLINGS = REGISTRY.channels.flatMap(({ directory, packageName, manifest }) => [
  // Not part of a longer word or of the scope: `agentcomms` is also the start of `@agentcomms/…`.
  { channel: directory, pattern: `(?<![@\\w-])${escapeRegExp(manifest.binary)}` },
  { channel: directory, pattern: `${escapeRegExp(packageName)}(?:@\\S+)?` },
]);
const INSTALL = new RegExp(
  `(${SPELLINGS.map((spelling) => spelling.pattern).join('|')}) mcp install([^\`|"\\n]*)`,
  'g',
);
const channelOf = (spelled) =>
  SPELLINGS.find((spelling) => new RegExp(`^(?:${spelling.pattern})$`).test(spelled))?.channel;

/** The flags `mcp install --help` lists, read with a scratch home: `--help` reads no config, and must not start to. */
async function installFlags(cli) {
  const home = await mkdtemp(join(tmpdir(), 'install-docs-'));
  const { stdout } = await run(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      join(ROOT, 'packages', cli, 'src', 'cli.ts'),
      'mcp',
      'install',
      '--help',
    ],
    {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        USERPROFILE: home,
        AGENT_COMMS_CONFIG_DIR: join(home, 'config'),
        NO_COLOR: '1',
        AGENT_COMMS_UPDATE_CHECK: 'off',
      },
    },
  ).finally(() => rm(home, { recursive: true, force: true }));
  return new Set(stdout.match(/--[a-z][a-z-]*/g) ?? []);
}

test('every `mcp install` a document gives names a client, and passes only flags the CLI has', async () => {
  const known = Object.fromEntries(
    await Promise.all(REGISTRY.channels.map(async ({ directory }) => [directory, await installFlags(directory)])),
  );
  assert.ok(known.gmail.has('--client') && known.slack.has('--force'), 'the help text was not read');
  assert.ok(known.core.has('--client') && known.core.has('--approval'), 'the core usage table was not read');

  const wrong = [];
  let seen = 0;
  for (const { path, text } of await documents()) {
    for (const { command, cli, flags } of installCommands(text)) {
      seen += 1;
      if (!flags.includes('--client')) wrong.push(`${path}: ${command} has no --client`);
      for (const flag of flags) if (!known[cli].has(flag)) wrong.push(`${path}: ${command} passes ${flag}`);
    }
  }
  assert.ok(seen > 10, `only ${seen} commands found — the pattern is wrong`);
  assert.deepEqual(wrong, []);
});

test("a command that re-registers an entry that is already there carries --force, or is doctor's own fix", async () => {
  const wrong = [];
  for (const { path, text } of await documents()) {
    for (const line of text.split('\n')) {
      if (!/mcp install/.test(line) || !/re-?register|rewrites|re-run|mcp-command/i.test(line)) continue;
      if (/--force|the `fix`/.test(line)) continue;
      wrong.push(`${path}: ${line.trim()}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('doctor checks are picked out by id, the field every check has', async () => {
  const wrong = [];
  for (const { path, text } of await documents()) {
    for (const line of text.split('\n')) {
      if (/doctor/.test(line) && /select\(\.name\b/.test(line)) wrong.push(`${path}: ${line.trim()}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('no document promises that prune keeps whatever any client registers', async () => {
  const wrong = [];
  for (const { path, text } of await documents()) {
    // Prose wraps, so the words are matched across line breaks.
    const prose = text.replace(/\s+/g, ' ');
    for (const [promise] of prose.matchAll(
      /\b(?:any|no) (?:MCP )?client registers\b|keeps anything a client registers/gi,
    )) {
      wrong.push(`${path}: ${promise}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('troubleshooting gives 0.13.0’s bare commands a best-effort way to run, at that exact release and never latest (CUE-403)', async () => {
  // Design 2026-10-04, D7: what a person can do with a command 0.13.0 or earlier printed by its bare name, and what
  // that cannot recover. And D8 and §5: PATH shims are a follow-up, and on Windows a default Node gives words to type.
  const page = await readFile(join(ROOT, 'docs', 'troubleshooting.md'), 'utf8');
  const start = page.indexOf('### A command a result gave you is not found');
  assert.notEqual(start, -1, 'the section is there');
  const end = page.indexOf('\n### ', start + 4);
  const section = page.slice(start, end === -1 ? undefined : end);
  const prose = section.replace(/\s+/g, ' ');

  // 0.13.1: the command, the words to type, or none here.
  assert.match(prose, /names the Node and the file of the installation that printed it/);
  assert.match(prose, /not locatable here/);
  assert.match(prose, /C:\\Program Files/);
  assert.match(prose, /words to type/);
  // The two routes for an older result: a managed registration's own Node and entry, and npx at exactly that release.
  assert.match(prose, /best effort/i);
  assert.match(section, /runtime\/0\.13\.0-<product>\/node_modules\/@agentcomms\/<product>\/dist\/cli\.mjs/);
  assert.match(section, /npx -y @agentcomms\/<product>@0\.13\.0 /);
  // Every package spec — not a path through a package's folder — names that exact release.
  for (const [spec] of section.matchAll(/@agentcomms\/[a-z<>-]+(?![\w/<>-])(?:@\S+)?/g)) {
    assert.match(spec, /@0\.13\.0$/, `${spec}: the exact release that printed it, never latest or a range`);
  }
  assert.doesNotMatch(section, /latest/, 'never latest');
  // What neither can do.
  assert.match(prose, /global install or a checkout/);
  assert.match(prose, /AGENT_COMMS_CONFIG_DIR/);
  assert.match(prose, /`comms_paths`.*cannot/);
  assert.match(prose, /npx may not be installed/i);
  assert.match(prose, /may not name its Node/);
  // PATH shims are not part of this.
  assert.match(prose, /PATH shims/);
  assert.match(prose, /follow-up/);
});

test('no guide hands a person a bare approve command: they run the one the result gives (CUE-403)', async () => {
  /*
   * Every channel's approve, from its manifest (`agent-gmail approve`), in any case and with a Windows extension, and
   * any approve through npx. A person approving runs the command the result gives — this installation's Node and CLI
   * file, its folders pinned — so prose never names one of these as what they run. A CLI's own listing (a code block,
   * a reference table's row) may show its approve, and then says so on the same line. The troubleshooting section on
   * what 0.13.0 printed names its bare commands on purpose.
   */
  const approves = [
    ...REGISTRY.channels.map(({ manifest }) => {
      const [binary, ...words] = manifest.approve.split(' ');
      return new RegExp(
        `(?<![\\w@/-])${escapeRegExp(binary)}(?:\\.(?:cmd|exe|ps1|bat))?\\s+${words.map(escapeRegExp).join('\\s+')}\\b`,
        'i',
      );
    }),
    /\b(?:npx|pnpx|bunx|npm exec|pnpm dlx|yarn dlx)\b[^`\n]*@agentcomms\/[a-z-]+(?:@\S+)?\s+approve\b/i,
  ];
  const wrong = [];
  let seen = 0;
  for (const { path, text } of await documents()) {
    let fenced = false;
    let fallback = false;
    for (const line of text.split('\n')) {
      if (/^\s*(?:```|~~~)/.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (!fenced && /^#{1,6} /.test(line)) fallback = /A command a result gave you is not found/.test(line);
      if (fallback || !approves.some((pattern) => pattern.test(line))) continue;
      seen += 1;
      const listing = fenced || /^\s*\|/.test(line);
      if (listing && /the command the result gives/i.test(line)) continue;
      wrong.push(`${path}: ${line.trim()}`);
    }
  }
  assert.ok(seen > 0, 'the CLI listings that show an approve are read');
  assert.deepEqual(wrong, [], `a bare approve handed to a person:\n${wrong.join('\n')}`);
});

// ── How long an approval lasts, and what a guide says of it (CUE-404) ────────────────────────────────────────────

/** A document's sentences, and its table cells, each read whole across its line breaks. */
function sentences(text) {
  const out = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    for (const piece of paragraph.replace(/\s+/g, ' ').split(/(?<=\.)\s+|\s*\|\s*/)) {
      if (piece.trim() !== '') out.push(piece.trim());
    }
  }
  return out;
}

test('no guide or skill gives an approval ten minutes flat: ten minutes is the chat route’s (CUE-404, §D1)', async () => {
  /*
   * 0.14.0 gives a send or change three lifetimes by its route: ten minutes for a yes in the chat, thirty for one
   * that waits for a person outside it, and 24 hours once that person approved. A sentence that gives an approval ten
   * minutes says it is the chat route's — or is about a probe, whose ten minutes are its own. The sign-in links'
   * ten minutes name no approval and are not read here.
   */
  const wrong = [];
  for (const { path, text } of await documents()) {
    for (const sentence of sentences(text)) {
      if (!/\b(?:ten|10)[- ]minutes?\b/i.test(sentence) || !/approv/i.test(sentence)) continue;
      if (/\bchat\b|\bprobe\b/i.test(sentence)) continue;
      wrong.push(`${path}: ${sentence}`);
    }
  }
  assert.deepEqual(wrong, [], `an approval given ten minutes without its route:\n${wrong.join('\n')}`);
});

test('the sending guide says how long an approval lasts, how an agent learns of it, and what each outcome means (CUE-404)', async () => {
  const page = (await readFile(join(ROOT, 'docs', 'sending.md'), 'utf8')).replace(/\s+/g, ' ');
  const required = [
    // §D1: the three lifetimes, and the download's own.
    /ten minutes/,
    /thirty minutes/,
    /24 hours/,
    // §D3: the four waits, status at zero, and that a wait only looks.
    /`gmail_send_wait`/,
    /`slack_approval_wait`/,
    /`resend_send_wait`/,
    /`comms_approval_wait`/,
    /--wait-seconds 0/,
    // §D1: a no said in the chat is revoked by the agent.
    /\bsays? no\b[^.]*revok/i,
    // §D2, §D8: the honest outcomes.
    /`claimable`/,
    /`SEND_OUTCOME_UNKNOWN`/,
    /this approval expired; nothing was sent with it/,
    /being sent by another call/,
    /sent; the provider returned no id/,
    /late result/,
    // §D9: what the records read can prove of a draft, and what Drafts says now.
    /not sent with any approval in the last 90 days/,
    /not sent with any of the 500 most recently changed approval records/,
    /still in Drafts/,
    /no longer in Drafts — it may have been sent or deleted elsewhere/,
    /\{ approvals, unsent \}/,
    // Retention.
    /90 days/,
    /once a day/,
    /5 seconds|five seconds/,
    // §7: the accepted risks.
    /24-hour|for 24 hours/,
  ];
  for (const pattern of required) assert.match(page, pattern, `docs/sending.md: missing ${pattern}`);
});

test('the upgrading guide says what 0.14.0 does to a configuration and to a server still on 0.13 (CUE-404, §4 item 0)', async () => {
  const page = (await readFile(join(ROOT, 'docs', 'upgrading.md'), 'utf8')).replace(/\s+/g, ' ');
  const required = [
    /version 3/,
    /this release reads versions 1 and 2/,
    /[Rr]estart/,
    /prepared by an earlier release; prepare it again/,
    /records from an earlier release are still being retired/,
    /earlier-release approvals/,
    /prepare[^.]* again/,
  ];
  for (const pattern of required) assert.match(page, pattern, `docs/upgrading.md: missing ${pattern}`);
});

test('troubleshooting covers an unknown send outcome and a 0.13 server after the conversion (CUE-404)', async () => {
  const page = await readFile(join(ROOT, 'docs', 'troubleshooting.md'), 'utf8');
  assert.match(page, /^### `SEND_OUTCOME_UNKNOWN`/m);
  assert.match(page, /^### .*this release reads versions 1 and 2/m);
  assert.match(page, /^### `this approval expired; nothing was sent with it`/m);
});

test('SECURITY.md does not claim what an approval lasting a day leaves open (CUE-404, §7.1, §7.2)', async () => {
  const page = (await readFile(join(ROOT, 'SECURITY.md'), 'utf8')).replace(/\s+/g, ' ');
  const limits = page.slice(page.indexOf('## What the safety model does not claim'));
  assert.match(limits, /approved[^.]*24 hours|24 hours[^.]*approv/i);
  assert.match(limits, /any process[^.]*shares? the approval store/i);
  assert.match(limits, /says no/i);
});

test('CONTRIBUTING sends a person to a terminal through the approve-and-wait helpers core exports (CUE-404, §D7)', async () => {
  const page = await readFile(join(ROOT, 'CONTRIBUTING.md'), 'utf8');
  const start = page.indexOf('## Telling a person what to run');
  const section = page.slice(start, page.indexOf('\n## ', start + 4));
  assert.match(section, /packages\/core\/src\/approval-handoffs\.ts/);
  const source = await readFile(join(ROOT, 'packages', 'core', 'src', 'approval-handoffs.ts'), 'utf8');
  const index = await readFile(join(ROOT, 'packages', 'core', 'src', 'index.ts'), 'utf8');
  assert.match(index, /^export \* from '\.\/approval-handoffs\.ts';$/m, 'core exports the approval handoffs');
  const helpers = [
    'approveAndWaitSentence',
    'waitSentence',
    'changePendingHint',
    'approveRefusedHint',
    'APPROVAL_WAITS',
  ];
  for (const helper of helpers) {
    assert.match(section, new RegExp(`\`${helper}\\b`), `CONTRIBUTING names ${helper}`);
    assert.match(
      source,
      new RegExp(`export (?:function|const) ${helper}\\b`),
      `approval-handoffs.ts exports ${helper}`,
    );
  }
});
