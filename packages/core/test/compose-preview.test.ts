import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BUILT_IN_PROFILE,
  initialiseComposeProfile,
  listComposeProfiles,
  readComposeProfile,
} from '../src/compose-profile.ts';
import { renderMessagePreview } from '../src/render.ts';
import { tempDir } from './helpers/temp.ts';

const ESC = String.fromCharCode(0x1b);
const RLO = String.fromCodePoint(0x202e);

test('a preview shows the recipients before the body, and again after it', () => {
  const preview = renderMessagePreview({
    recipients: { from: 'jo@example.test', to: ['sam@partner.test'], cc: ['ana@partner.test'], bcc: [] },
    subject: 'Re: Phase 2 plan',
    body: 'Tuesday works. I will bring the revised numbers.',
    context: { inbox: 'work', draftId: 'r-123', note: 'nothing has been sent' },
  });

  assert.match(preview, /MESSAGE PREVIEW · inbox work · draft r-123 · nothing has been sent/);
  assert.match(preview, /To: {7}sam@partner\.test/);
  assert.match(preview, /Cc: {7}ana@partner\.test/);
  assert.match(preview, /Subject: {2}Re: Phase 2 plan/);
  assert.match(preview, /Body \(8 words, 48 characters\)/);
  // The recipients appear again below the body: a long message scrolls the header out of view.
  assert.match(preview, /── To sam@partner\.test · Cc ana@partner\.test · Bcc none$/);
});

test('a body cannot break out of its own fence', () => {
  const body = [
    'Here is the code:',
    '```',
    'const x = 1;',
    '```',
    'and here is a longer fence:',
    '````',
    'x',
    '````',
  ].join('\n');
  const preview = renderMessagePreview({
    recipients: { from: 'jo@example.test', to: ['sam@partner.test'], cc: [], bcc: [] },
    subject: 'Code',
    body,
  });

  // The fence used is longer than anything inside the body, so nothing in the body can close it.
  const fence = /\n(`{5,})text\n/.exec(preview)?.[1];
  assert.ok(fence, 'a fence longer than the backtick runs inside');
  assert.equal(preview.split(`\n${fence}`).length, 3, 'exactly one opening and one closing fence');
});

test('a message cannot repaint the terminal or reverse an address', () => {
  const preview = renderMessagePreview({
    recipients: {
      from: 'jo@example.test',
      // A right-to-left override in an address would display it backwards.
      to: [`sam@${RLO}tset.rentrap`],
      cc: [],
      bcc: [],
    },
    subject: `Invoice${ESC}[2K${ESC}[1A overwritten`,
    body: `Nothing to see${ESC}[1;31m here`,
  });

  assert.doesNotMatch(preview, new RegExp(ESC), 'no escape character survives into the preview');
  assert.match(preview, /<U\+001B>/);
  assert.match(preview, /<U\+202E>/);
});

test('attachments and warnings are part of what is approved', () => {
  const preview = renderMessagePreview({
    recipients: { from: 'jo@example.test', to: ['sam@partner.test'], cc: [], bcc: ['quiet@partner.test'] },
    subject: 'Invoice',
    body: 'Attached.',
    attachments: [{ filename: 'invoice.pdf', size: 412_000, mimeType: 'application/pdf' }],
    warnings: ['sam@partner.test has not been written to from this mailbox before'],
  });
  assert.match(preview, /Attach: {3}invoice\.pdf · 402 KB · application\/pdf/);
  assert.match(preview, /! sam@partner\.test has not been written to/);
  // Bcc is shown in both places: it is the line most easily missed and the most costly to get wrong.
  assert.match(preview, /Bcc: {6}quiet@partner\.test/);
  assert.match(preview, /Bcc quiet@partner\.test$/);
});

test('the writing profile layers: built-in, the user, the platform, then one mailbox', async () => {
  const directory = tempDir();

  // With nothing written, the built-in shape is what a writer gets.
  const bare = await readComposeProfile(directory, { platform: 'gmail', inbox: 'work' });
  assert.deepEqual(
    bare.sections.map((section) => section.layer),
    ['default'],
  );
  assert.match(bare.text, /Say the thing/);
  assert.ok(bare.candidates.some((path) => path.endsWith('gmail.md')));
  assert.ok(bare.candidates.some((path) => path.endsWith('inbox-work.md')));

  writeFileSync(join(directory, 'user.md'), '# Jo\n\n- Sign off with "C" to people you know.\n');
  writeFileSync(join(directory, 'gmail.md'), '# Gmail\n\n- Reply on the existing thread when one exists.\n');
  writeFileSync(join(directory, 'inbox-work.md'), '# Work\n\n- Never write to a client without a subject line.\n');

  const full = await readComposeProfile(directory, { platform: 'gmail', inbox: 'work' });
  assert.deepEqual(
    full.sections.map((section) => section.layer),
    ['default', 'user', 'platform', 'inbox'],
    'later layers refine earlier ones, in that order',
  );
  assert.match(full.text, /Sign off with "C"/);
  assert.match(full.text, /Reply on the existing thread/);
  assert.match(full.text, /Never write to a client/);
  assert.ok(full.text.indexOf('Sign off') < full.text.indexOf('Reply on the existing'));

  // Another mailbox does not inherit the first one's rules.
  const other = await readComposeProfile(directory, { platform: 'gmail', inbox: 'home' });
  assert.doesNotMatch(other.text, /Never write to a client/);

  // Nor does another platform.
  const chat = await readComposeProfile(directory, { platform: 'chat', inbox: 'work' });
  assert.doesNotMatch(chat.text, /Reply on the existing thread/);
});

test('a user who writes their own default replaces the built-in one', async () => {
  const directory = tempDir();
  const path = await initialiseComposeProfile(directory);
  assert.equal(readFileSync(path, 'utf8'), BUILT_IN_PROFILE);

  writeFileSync(path, '# Mine\n\n- Two sentences, never more.\n');
  const profile = await readComposeProfile(directory);
  assert.equal(profile.sections.length, 1);
  assert.match(profile.text, /Two sentences, never more/);
  assert.doesNotMatch(profile.text, /Say the thing/);

  // Initialising again does not overwrite what the user wrote.
  await initialiseComposeProfile(directory);
  assert.match(readFileSync(path, 'utf8'), /Two sentences/);
  assert.deepEqual(await listComposeProfiles(directory), ['default.md']);
});
