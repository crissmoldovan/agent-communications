import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { REGISTRY } from '../scripts/channels.mjs';

/*
 * A channel hands its update check to core's CLI, and nothing else of it starts core (design 2026-10-22, P2). The
 * hand-off is core's own code — `coreUpdateCheckWords` locates core's command at the channel's version, and
 * `startCheckChild` starts it — reached from a channel only through the `handOff` its command and server pass to
 * `terminalUpdateHooks` and `checkForUpdates`. So a channel's source starts no process it did not start before, names
 * neither function, and builds no `update-check-child` command of its own; and the one channel with no network at all
 * gains none of it (smoother-updates U9).
 *
 * Read from the registry: every channel but core, and every wrapper. A channel that declares no host is one with no
 * network, as WhatsApp is; one that declares hosts asks the registry, and hands its check on.
 */

const ROOT = REGISTRY.root;
const isCore = (channel) => channel.manifest.channel === 'core';
const CHANNELS = REGISTRY.channels.filter((channel) => !isCore(channel));
/** Every channel and wrapper but core: the packages a channel's bundle is built from. */
const DIRECTORIES = [...CHANNELS.map((channel) => channel.directory), ...Object.keys(REGISTRY.wrappers)].sort();

/** The source files of `packages/<directory>/src`, as paths from the repository's root with `/`. */
function sources(directory) {
  const root = join(ROOT, 'packages', directory, 'src');
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

const read = (file) => readFileSync(join(ROOT, file), 'utf8');
/** A module specifier naming `child_process`, however it is imported or required. */
const CHILD_PROCESS = /['"`](?:node:)?child_process['"`]/;

test('the registry names the channels and wrappers this reads', () => {
  // Not vacuous: each package read has source, and a channel with no network is among them.
  for (const directory of DIRECTORIES) assert.ok(sources(directory).length > 0, `packages/${directory}/src is empty`);
  assert.ok(DIRECTORIES.includes('gmail-mcp'), 'the wrapper is not read');
  assert.ok(
    CHANNELS.some((channel) => channel.manifest.hosts.length === 0),
    'no channel without network to hold to its guarantee',
  );
});

test("only today's five files of the channels start a process", () => {
  const starting = DIRECTORIES.flatMap(sources).filter((file) => CHILD_PROCESS.test(read(file)));
  assert.deepEqual(starting, [
    'packages/gmail/src/cli/browser.ts',
    'packages/gmail/src/operations/signin.ts',
    'packages/slack/src/cli/browser.ts',
    'packages/slack/src/operations/signin.ts',
    'packages/whatsapp/src/cli/opener.ts',
  ]);
});

test("no channel locates or starts core's update child itself", () => {
  for (const file of DIRECTORIES.flatMap(sources)) {
    const text = read(file);
    assert.doesNotMatch(text, /\b(?:coreUpdateCheckWords|startCheckChild)\b/, `${file} names core's hand-off`);
    // Core's command with the hidden words, located by the channel itself: `.core([…])` or `.of('core', […])`.
    assert.doesNotMatch(
      text,
      /\.(?:core\(|of\(\s*['"`]core['"`]\s*,)\s*\[[^\]]*(?:UPDATE_CHECK_CHILD_COMMAND|update-check-child)/,
      `${file} locates core's update child`,
    );
  }
  // In core, only the checker calls them: no other path spawns core's child.
  const calling = sources('core').filter((file) => /\b(?:startCheckChild|coreUpdateCheckWords)\(/.test(read(file)));
  assert.deepEqual(calling, ['packages/core/src/update-check.ts']);
});

test("updateHandOff reaches only the CLI programs and servers of Gmail, Slack and Resend, never WhatsApp's", () => {
  const networked = CHANNELS.filter((channel) => channel.manifest.hosts.length > 0);
  assert.deepEqual(networked.map((channel) => channel.directory).sort(), ['gmail', 'resend', 'slack']);
  for (const { directory } of networked) {
    const { cli, server } = REGISTRY.drivers[directory];
    const naming = sources(directory).filter((file) => /\bupdateHandOff\b/.test(read(file)));
    assert.deepEqual(naming, [cli, server].sort(), `${directory}: which files carry updateHandOff`);
    // Each passes it on, to the one call that takes it: the command's hooks, the server's refresh.
    assert.match(
      read(cli),
      /terminalUpdateHooks\(\s*core\s*,\s*env\s*,\s*\{\s*handOff:\s*deps\.updateHandOff\s*\?\?\s*\{\s*\}\s*\}\s*\)/,
      `${cli} does not hand its check on`,
    );
    assert.match(
      read(server),
      /checkForUpdates\(\s*context\.core\s*,\s*context\.env\s*,\s*\{\s*handOff:\s*options\.updateHandOff\s*\?\?\s*\{\s*\}\s*\}\s*\)/,
      `${server} does not hand its check on`,
    );
  }
  // A channel with no network asks no registry at all, so it has no check to hand on: not a word of it.
  for (const { directory } of CHANNELS.filter((channel) => channel.manifest.hosts.length === 0)) {
    for (const file of sources(directory)) {
      assert.doesNotMatch(
        read(file),
        /\b(?:updateHandOff|handOff|CoreHandOff|terminalUpdateHooks|checkForUpdates)\b/,
        `${file} has a check to hand on`,
      );
    }
  }
  for (const wrapper of Object.keys(REGISTRY.wrappers)) {
    for (const file of sources(wrapper)) assert.doesNotMatch(read(file), /\bupdateHandOff\b/, file);
  }
});
