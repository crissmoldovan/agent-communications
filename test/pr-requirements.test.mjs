import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  branchSlug,
  checkPullRequest,
  commentFor,
  MARKER,
  nextVersions,
  PROVENANCE_LABELS,
  REQUIRED_CHECKS,
  SECTIONS,
  sectionsOf,
} from '../scripts/pr-requirements.mjs';

/**
 * What every pull request carries (CONTRIBUTING.md), as far as its description and file list can show it.
 *
 * The check's job is to tell a submitter what is missing, so each test names one thing a pull request can lack and
 * holds the check to saying so — and the complete one to saying nothing. The template and the check are held to each
 * other too: a heading or label renamed in one and not the other would make every pull request fail, or none.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A pull request that carries everything, on a branch whose slug is `slack-edit-delete`, against 0.14.1. */
function complete(over = {}) {
  const body = `## What changes for the person using it

An agent can edit or delete a message this account posted, through the gate a post goes through.

## How

operations/amend.ts is the gate; read its last look first.

## Proposed version

0.15.0-slack-edit-delete — a minor: two new tools, and nothing that exists changes.

## Provenance

- **Why:** the owner asked for it in the issue it links.
- **Sources:** Slack's chat.update and chat.delete pages, read 2026-10-06.
- **Live testing:** one probe in my own DM, recorded in docs/research, everything deleted afterwards.
- **AI assistance:** Claude Code wrote the first draft of amend.ts.

## Checks

- [x] \`pnpm verify\` passes locally
- [x] Tests cover the change, and I broke each guard on purpose to see its test fail
- [x] No real email, address, token, client secret or account id in code, fixtures or docs
- [x] Docs and skills updated where a command, tool or behaviour changed
- [x] \`CHANGELOG.md\` updated under \`## Unreleased\` when users will notice
`;
  return {
    body,
    headRef: 'feat/slack-edit-delete',
    currentVersion: '0.14.1',
    files: [
      'packages/slack/src/operations/amend.ts',
      'packages/slack/test/edit.test.ts',
      'CHANGELOG.md',
      'packages/slack/README.md',
    ],
    ...over,
  };
}

test('a pull request that carries everything is told so, with its version and step', () => {
  const result = checkPullRequest(complete());
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.proposal, {
    version: '0.15.0-slack-edit-delete',
    number: '0.15.0',
    slug: 'slack-edit-delete',
    step: 'minor',
  });
  assert.match(
    commentFor('omar', result),
    /Everything this repository asks of a pull request is here.*0\.15\.0-slack-edit-delete.*minor/,
  );
});

test('no proposed version is asked for, naming the slug the branch gives', () => {
  const { body, ...rest } = complete();
  const result = checkPullRequest({ ...rest, body: body.replace(/0\.15\.0-slack-edit-delete — /, '') });
  assert.ok(
    result.missing.some((line) => line.includes('A proposed version, as `X.Y.Z-slack-edit-delete`')),
    result.missing.join('\n'),
  );
});

test('a version that is not one semver step on from main is refused, with the three that are', () => {
  for (const wrong of ['0.14.1', '0.16.0', '0.15.1', '1.1.0', '0.14.3']) {
    const pr = complete();
    const result = checkPullRequest({
      ...pr,
      body: pr.body.replace('0.15.0-slack-edit-delete', `${wrong}-slack-edit-delete`),
    });
    assert.ok(
      result.missing.some((line) => line.includes('a patch is 0.14.2, a minor 0.15.0, a major 1.0.0')),
      `${wrong}: ${result.missing.join('\n')}`,
    );
  }
  for (const [right, step] of [
    ['0.14.2', 'patch'],
    ['0.15.0', 'minor'],
    ['1.0.0', 'major'],
  ]) {
    const pr = complete();
    const result = checkPullRequest({
      ...pr,
      body: pr.body.replace('0.15.0-slack-edit-delete — a minor', `${right}-slack-edit-delete — a ${step}`),
    });
    assert.deepEqual(result.missing, [], right);
    assert.equal(result.proposal.step, step);
  }
});

test("a version whose slug is not the branch's is asked to carry the branch's", () => {
  const result = checkPullRequest(complete({ headRef: 'fix/slack-edit' }));
  assert.ok(
    result.missing.some((line) => line.includes('`0.15.0-slack-edit`, not `0.15.0-slack-edit-delete`')),
    result.missing.join('\n'),
  );
});

test("the template's guidance is not the submitter's words: an untouched template is missing everything", async () => {
  const template = await readFile(join(ROOT, '.github', 'PULL_REQUEST_TEMPLATE.md'), 'utf8');
  const result = checkPullRequest({ body: template, headRef: 'feat/x', currentVersion: '0.14.1', files: [] });
  for (const name of ['What changes for the person using it', 'How']) {
    assert.ok(
      result.missing.some((line) => line.includes(`"${name}" section`)),
      name,
    );
  }
  assert.ok(result.missing.some((line) => line.startsWith('A proposed version, as `X.Y.Z-x`')));
  for (const label of PROVENANCE_LABELS) {
    assert.ok(
      result.missing.some((line) => line.includes(`**${label}:** says nothing`)),
      label,
    );
  }
  assert.ok(result.missing.some((line) => line.startsWith('A box is not ticked')));
});

test('the template has every heading and provenance label the check reads, so the two cannot drift apart', async () => {
  const template = await readFile(join(ROOT, '.github', 'PULL_REQUEST_TEMPLATE.md'), 'utf8');
  const headings = [...sectionsOf(template).keys()];
  for (const name of SECTIONS) assert.ok(headings.includes(name), `the template has no "## ${name}"`);
  for (const label of PROVENANCE_LABELS)
    assert.ok(template.includes(`- **${label}:**`), `the template has no **${label}:**`);
});

test('a provenance label left empty is asked for by name', () => {
  for (const label of PROVENANCE_LABELS) {
    const pr = complete();
    const body = pr.body.replace(new RegExp(`(- \\*\\*${label}:\\*\\*).*`), '$1 <!-- left as the template had it -->');
    const result = checkPullRequest({ ...pr, body });
    assert.deepEqual(
      result.missing,
      [`Under "Provenance", **${label}:** says nothing — write what applies, or "none" and why.`],
      label,
    );
  }
});

test('a description with no version or provenance at all gets one line for each, not one per part', () => {
  const pr = complete();
  const body = pr.body.replace(/## Proposed version[\s\S]*?(?=## Checks)/, '');
  const result = checkPullRequest({ ...pr, body });
  assert.deepEqual(result.missing, [
    'A proposed version, as `X.Y.Z-slack-edit-delete` under "Proposed version", with why it is a patch, a minor or a major change.',
    'A "Provenance" section, from the template: **Why:**, **Sources:**, **Live testing:** and **AI assistance:**, each saying what applies, or "none" and why.',
  ]);
});

test('a deleted box is not a ticked one: each required box is asked back, the whole checklist too', () => {
  const pr = complete();
  const noChecks = checkPullRequest({ ...pr, body: pr.body.replace(/## Checks[\s\S]*$/, '') });
  assert.deepEqual(
    noChecks.missing,
    REQUIRED_CHECKS.map(
      (check) => `The box "${check}…" is missing from "Checks": put it back from the template, and tick it.`,
    ),
  );
  const oneGone = checkPullRequest({ ...pr, body: pr.body.replace(/^- \[x\] No real email.*$/m, '') });
  assert.deepEqual(oneGone.missing, [
    'The box "No real email, address, token, client secret or account id…" is missing from "Checks": put it back from the template, and tick it.',
  ]);
});

test('every required box is one the template has, so the two cannot drift apart', async () => {
  const template = await readFile(join(ROOT, '.github', 'PULL_REQUEST_TEMPLATE.md'), 'utf8');
  const boxes = template.split('\n').filter((line) => line.startsWith('- [ ] '));
  for (const check of REQUIRED_CHECKS)
    assert.ok(
      boxes.some((box) => box.includes(check)),
      check,
    );
  assert.equal(boxes.length, REQUIRED_CHECKS.length, 'a box in the template that the check does not require');
});

test('a proposed version needs its reason: the step named, as the number makes it, and why in words', () => {
  const pr = complete();
  const reasonless = `Under "Proposed version", say why \`0.15.0-slack-edit-delete\` is a minor: name the step — patch, minor or major — and the reason, in a sentence.`;
  const bare = pr.body.replace(/^0\.15\.0-slack-edit-delete — .*$/m, '0.15.0-slack-edit-delete');
  assert.deepEqual(checkPullRequest({ ...pr, body: bare }).missing, [reasonless]);
  const wordOnly = pr.body.replace(/^0\.15\.0-slack-edit-delete — .*$/m, '0.15.0-slack-edit-delete — minor.');
  assert.deepEqual(checkPullRequest({ ...pr, body: wordOnly }).missing, [reasonless]);
  const noStep = pr.body.replace(
    /^0\.15\.0-slack-edit-delete — .*$/m,
    '0.15.0-slack-edit-delete — two new tools arrive.',
  );
  assert.deepEqual(checkPullRequest({ ...pr, body: noStep }).missing, [reasonless]);
  const wrongStep = pr.body.replace('— a minor:', '— a patch:');
  assert.deepEqual(checkPullRequest({ ...pr, body: wrongStep }).missing, [
    'The proposed version `0.15.0-slack-edit-delete` is a minor by its number, but its reason calls it a patch.',
  ]);
});

test('an unticked box is named', () => {
  const pr = complete();
  const result = checkPullRequest({
    ...pr,
    body: pr.body.replace('- [x] Tests cover the change', '- [ ] Tests cover the change'),
  });
  assert.deepEqual(result.missing, [
    'A box is not ticked: "Tests cover the change, and I broke each guard on purpose to see its test fail". Do it and tick it, or say in the box why it does not apply.',
  ]);
});

test('code without tests, a package change without a changelog entry or docs, are each asked for', () => {
  const code = ['packages/slack/src/operations/amend.ts'];
  const result = checkPullRequest(complete({ files: code }));
  assert.equal(result.missing.length, 3, result.missing.join('\n'));
  assert.match(result.missing[0], /^Tests:/);
  assert.match(result.missing[1], /CHANGELOG\.md/);
  assert.match(result.missing[2], /^Documentation:/);

  // A script is code and needs tests, but ships in no package, so it needs neither a changelog entry nor docs.
  const script = checkPullRequest(complete({ files: ['scripts/pr-requirements.mjs'] }));
  assert.deepEqual(script.missing, ['Tests: the code changed and no test did. Add the tests that prove the change.']);

  // A change to capabilities.json is a change to the surfaces, so it needs docs.
  const capabilities = checkPullRequest(complete({ files: ['capabilities.json', 'test/parity.test.mjs'] }));
  assert.deepEqual(capabilities.missing, [
    'Documentation: a package changed and no README, guide, reference page or skill did.',
  ]);

  // Documentation alone needs nothing more.
  assert.deepEqual(checkPullRequest(complete({ files: ['docs/troubleshooting.md'] })).missing, []);
});

test('a package change nobody will notice can say so instead of a changelog entry, but only with its reason', () => {
  const files = [
    'packages/slack/src/operations/post.ts',
    'packages/slack/test/edit-files.test.ts',
    'packages/slack/README.md',
  ];
  const pr = complete({ files });
  assert.ok(checkPullRequest(pr).missing.some((line) => line.includes('CHANGELOG.md')));
  const said = checkPullRequest({ ...pr, body: `${pr.body}\nNo changelog: only a hint's example id changes.\n` });
  assert.deepEqual(said.missing, []);
  const empty = checkPullRequest({ ...pr, body: `${pr.body}\nNo changelog:\n` });
  assert.ok(empty.missing.some((line) => line.includes('CHANGELOG.md')));
  const inAComment = checkPullRequest({ ...pr, body: `${pr.body}\n<!-- No changelog: hidden -->\n` });
  assert.ok(inAComment.missing.some((line) => line.includes('CHANGELOG.md')));
});

test('the comment names the submitter, links the rule, lists what is missing, and carries its marker', () => {
  const comment = commentFor('omar', { missing: ['one thing', 'another'] }, 'owner/repo');
  assert.ok(comment.startsWith(MARKER));
  assert.match(comment, /@omar, thanks for this/);
  assert.match(
    comment,
    /https:\/\/github\.com\/owner\/repo\/blob\/main\/CONTRIBUTING\.md#what-every-pull-request-carries/,
  );
  assert.match(comment, /^- one thing$/m);
  assert.match(comment, /^- another$/m);
  assert.match(comment, /Nobody will fill these in for you/);
});

test('CONTRIBUTING.md has the section the comment links to', async () => {
  const contributing = await readFile(join(ROOT, 'CONTRIBUTING.md'), 'utf8');
  assert.match(contributing, /^### What every pull request carries$/m);
});

test('the slug is the branch’s last segment, and the next versions are the three semver steps', () => {
  assert.equal(branchSlug('feat/slack-edit-delete'), 'slack-edit-delete');
  assert.equal(branchSlug('fix/Slack_Team Param'), 'slack-team-param');
  assert.equal(branchSlug('main'), 'main');
  assert.deepEqual(nextVersions('0.14.1'), { patch: '0.14.2', minor: '0.15.0', major: '1.0.0' });
  assert.deepEqual(nextVersions('1.9.9'), { patch: '1.9.10', minor: '1.10.0', major: '2.0.0' });
});

test('the workflow runs the base branch’s copy of the check and never checks out the pull request', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'pr-requirements.yml'), 'utf8');
  assert.match(workflow, /^\s+pull_request_target:/m);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /pull_request\.head\.(sha|ref)|github\.head_ref|pnpm install|npm (ci|install)/);
  assert.match(workflow, /node scripts\/pr-requirements\.mjs --github/);
});
