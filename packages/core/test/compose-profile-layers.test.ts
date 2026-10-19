import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  conversationProfileFile,
  inboxProfileFile,
  PROFILE_LAYERS,
  PROFILE_STARTER,
  readComposeProfile,
} from '../src/compose-profile.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * Task 5 of the behaviour rules (design 2026-10-19-agent-behaviour-rules, B6): the writing profile gains an account
 * layer and a conversation layer. The account layer keeps the `inbox-<account>.md` file names people have written, and
 * a conversation's file is named after the account and the conversation, with anything a file name cannot hold encoded.
 *
 * Every test reads files in a temporary folder; nothing here reads a real profile or talks to a channel.
 */

test('the five layers, in the order they apply', async () => {
  assert.deepEqual([...PROFILE_LAYERS], ['default', 'user', 'platform', 'account', 'conversation']);

  const directory = tempDir('comms-profile-');
  writeFileSync(join(directory, 'default.md'), '- Everywhere.\n');
  writeFileSync(join(directory, 'user.md'), '- As Jo.\n');
  writeFileSync(join(directory, 'slack.md'), '- In Slack.\n');
  writeFileSync(join(directory, inboxProfileFile('acme/slack')), '- In this workspace.\n');
  writeFileSync(join(directory, conversationProfileFile('acme/slack', 'C01')), '- In this channel.\n');

  const profile = await readComposeProfile(directory, {
    platform: 'slack',
    account: 'acme/slack',
    conversations: ['C01'],
  });
  assert.deepEqual(
    profile.sections.map((section) => section.layer),
    ['default', 'user', 'platform', 'account', 'conversation'],
  );
  const order = ['Everywhere', 'As Jo', 'In Slack', 'In this workspace', 'In this channel'].map((words) =>
    profile.text.indexOf(words),
  );
  assert.ok(
    order.every((at, index) => at !== -1 && (index === 0 || at > (order[index - 1] as number))),
    `later layers come after earlier ones: ${order.join(', ')}`,
  );
});

test('an inbox-<account>.md written before this release is still read, as the account layer', async () => {
  const directory = tempDir('comms-profile-');
  writeFileSync(join(directory, 'inbox-acme__gmail.md'), '- Never write to a client without a subject line.\n');

  // By the new name for it…
  const byAccount = await readComposeProfile(directory, { platform: 'gmail', account: 'acme/gmail' });
  const section = byAccount.sections.find((entry) => entry.layer === 'account');
  assert.ok(section, 'the old file is the account layer');
  assert.equal(section.source, join(directory, 'inbox-acme__gmail.md'));
  assert.match(byAccount.text, /Never write to a client/);

  // …and by the old one, which Gmail's draft tools still pass.
  const byInbox = await readComposeProfile(directory, { platform: 'gmail', inbox: 'acme/gmail' });
  assert.deepEqual(byInbox, byAccount);

  // Slack and Resend accounts take the same pattern.
  assert.equal(inboxProfileFile('cue/slack'), 'inbox-cue__slack.md');
});

test('a conversation file is named after its account and its conversation', () => {
  assert.equal(conversationProfileFile('acme/slack', 'C01'), 'conversation-acme__slack__C01.md');
  assert.equal(conversationProfileFile('acme/slack', 'D0ABC'), 'conversation-acme__slack__D0ABC.md');
  // `@` is kept; a domain is a conversation of its own.
  assert.equal(conversationProfileFile('acme/gmail', '@client.test'), 'conversation-acme__gmail__@client.test.md');
});

test('an address with + in it is encoded as %2B, and what a file name cannot hold as %XX', () => {
  assert.equal(
    conversationProfileFile('acme/gmail', 'sam+news@client.test'),
    'conversation-acme__gmail__sam%2Bnews@client.test.md',
  );
  // `%` itself, so two conversations never share a file; and bytes beyond ASCII, one %XX per UTF-8 byte.
  assert.equal(conversationProfileFile('acme/gmail', 'a%2b@x.test'), 'conversation-acme__gmail__a%252b@x.test.md');
  assert.equal(conversationProfileFile('acme/gmail', 'zoë@x.test'), 'conversation-acme__gmail__zo%C3%AB@x.test.md');
  // Addresses are compared lower-cased, as the behaviour rules compare them, so one file serves every spelling.
  assert.equal(
    conversationProfileFile('acme/gmail', 'Sam@Client.TEST'),
    conversationProfileFile('acme/gmail', 'sam@client.test'),
  );
  // A Slack id keeps its case: Slack writes them upper-case, and C01 is not c01.
  assert.notEqual(conversationProfileFile('acme/slack', 'C01'), conversationProfileFile('acme/slack', 'c01'));
  // Every name is one a Windows folder can hold: none of \ / : * ? " < > | in it.
  for (const conversation of ['a:b@x.test', 'a*b@x.test', 'a?b@x.test', 'a|b@x.test', 'a/b@x.test', 'a\\b@x.test']) {
    const name = conversationProfileFile('acme/gmail', conversation);
    assert.doesNotMatch(name, /[\\/:*?"<>|]/, name);
  }
});

test('several conversation files are joined, in the order given, each marked with its source', async () => {
  const directory = tempDir('comms-profile-');
  const sam = join(directory, conversationProfileFile('acme/gmail', 'sam@client.test'));
  const client = join(directory, conversationProfileFile('acme/gmail', '@client.test'));
  const lee = join(directory, conversationProfileFile('acme/gmail', 'lee@other.test'));
  writeFileSync(sam, '- Sam prefers bullet points.\n');
  writeFileSync(client, '- Client mail is formal.\n');
  writeFileSync(lee, '- Lee writes in French.\n');

  const profile = await readComposeProfile(directory, {
    platform: 'gmail',
    account: 'acme/gmail',
    // As a caller passes mail recipients: each address, then its domain, in recipient order.
    conversations: ['sam@client.test', '@client.test', 'lee@other.test', '@other.test'],
  });
  const conversations = profile.sections.filter((section) => section.layer === 'conversation');
  assert.deepEqual(
    conversations.map((section) => [section.conversation, section.source]),
    [
      ['sam@client.test', sam],
      ['@client.test', client],
      ['lee@other.test', lee],
    ],
  );
  for (const section of conversations) {
    assert.ok(profile.text.includes(`<!-- conversation: ${section.source} -->\n${section.text}`), section.source);
  }
  assert.ok(profile.text.indexOf('Sam prefers') < profile.text.indexOf('Client mail'));
  assert.ok(profile.text.indexOf('Client mail') < profile.text.indexOf('Lee writes'));
  // The one not written is still a file it would read.
  assert.ok(profile.candidates.includes(join(directory, conversationProfileFile('acme/gmail', '@other.test'))));
});

test('a conversation written under a former name of its account keeps applying, until one is written under the new', async () => {
  const directory = tempDir('comms-profile-');
  const old = join(directory, conversationProfileFile('work', 'C01'));
  writeFileSync(old, '- Old channel rules.\n');
  const options = { platform: 'slack', account: 'acme/slack', formerAccounts: ['work'], conversations: ['C01'] };
  const before = await readComposeProfile(directory, options);
  assert.deepEqual(
    before.sections.filter((section) => section.layer === 'conversation').map((section) => section.source),
    [old],
  );

  writeFileSync(join(directory, conversationProfileFile('acme/slack', 'C01')), '- New channel rules.\n');
  const after = await readComposeProfile(directory, options);
  assert.match(after.text, /New channel rules/);
  assert.doesNotMatch(after.text, /Old channel rules/);
});

test('the starter has the five headings, each with one line of example', () => {
  const headings = [...PROFILE_STARTER.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(headings, ['Tone', 'Language', 'Length', 'Sign-off', 'Threads']);
  for (const block of PROFILE_STARTER.split(/^## .+$/m).slice(1)) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    assert.equal(lines.length, 1, `one line of example: ${JSON.stringify(block)}`);
    assert.match(lines[0] as string, /^- \S/);
  }
  assert.match(PROFILE_STARTER, /^## Threads\n\n- Reply in the thread; start a new message only when asked\.$/m);
});
