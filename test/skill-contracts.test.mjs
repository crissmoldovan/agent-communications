import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Each skill carries its own platform's contract, and nothing from another platform's.
 *
 * The three Slack skills shipped with the Gmail contract copied into them word for word: an agent following
 * `slack-reading` was told to call `gmail_inboxes_list`, that only `gmail-send` sends, and to fall back to
 * `npx @agentcomms/gmail` when the Slack tools were missing. `sync-skills --check` passed, because the copies
 * matched their source — the source was simply the wrong one. This checks the thing that was wrong.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKILLS = join(ROOT, 'skills');

/** What one platform's skills must never name, because it belongs to the other. */
const FOREIGN = {
  gmail: [/\bslack_[a-z_]+/, /\bagent-slack\b/, /@agentcomms\/slack\b/],
  slack: [/\bgmail_[a-z_]+/, /\bagent-gmail\b/, /@agentcomms\/gmail/, /\bmailbox(es)?\b/i, /\bgmail-send\b/],
};

async function skills() {
  return (await readdir(SKILLS, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();
}

test('every skill carries the contract of its own platform', async () => {
  for (const name of await skills()) {
    const platform = name.split('-')[0];
    const source = await readFile(join(SKILLS, '_shared', `contract-${platform}.md`), 'utf8');
    const copy = await readFile(join(SKILLS, name, 'references', 'contract.md'), 'utf8');
    assert.equal(copy, source, `${name} should carry _shared/contract-${platform}.md`);
  }
});

test('no skill names another platform’s tools, commands or package', async () => {
  const offenders = [];
  for (const name of await skills()) {
    const platform = name.split('-')[0];
    const directory = join(SKILLS, name);
    for (const file of await readdir(directory, { recursive: true })) {
      if (!file.endsWith('.md')) continue;
      const text = await readFile(join(directory, file), 'utf8');
      for (const pattern of FOREIGN[platform] ?? []) {
        const found = pattern.exec(text);
        if (found) offenders.push(`skills/${name}/${file}: ${found[0]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `a skill that borrows another platform's words:\n${offenders.join('\n')}`);
});
