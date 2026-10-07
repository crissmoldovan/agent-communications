#!/usr/bin/env node
/**
 * What every pull request carries, checked from what GitHub knows about it — never by running its code.
 *
 * CONTRIBUTING.md ("What every pull request carries") is the rule; this is the part of it a machine can see: a proposed
 * version named after the branch, the template's sections filled in, every box ticked, and tests, a changelog entry and
 * documentation beside a change to the code. What it cannot judge — whether the tests are good, whether the provenance
 * is true — stays the reviewer's.
 *
 * It runs from `.github/workflows/pr-requirements.yml` under `pull_request_target`, from the base branch's copy, so a
 * pull request cannot change the check it is held to. It reads the pull request's description, branch and file list
 * through the API and leaves one comment, edited in place, telling the submitter what is missing. Nothing here fills
 * anything in for them.
 *
 *   node scripts/pr-requirements.mjs --github     # in the workflow: read the event, comment, exit 1 when incomplete
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** The template's headings the check reads, in the order the template has them. */
export const SECTIONS = Object.freeze([
  'What changes for the person using it',
  'How',
  'Proposed version',
  'Provenance',
]);

/** The labelled lines under "Provenance": each must say something, even if it is "none". */
export const PROVENANCE_LABELS = Object.freeze(['Why', 'Sources', 'Live testing', 'AI assistance']);

/** The comment's own marker, so a later run edits it rather than adding another. */
export const MARKER = '<!-- pr-requirements -->';

const VERSION = /\b(\d+)\.(\d+)\.(\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)\b/;

/** HTML comments are the template's guidance, not the submitter's words. */
function withoutComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

/** Each `## heading` and what is written under it, up to the next one. */
export function sectionsOf(body) {
  const sections = new Map();
  let current;
  for (const line of withoutComments(body ?? '').split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      current = heading[1].trim();
      sections.set(current, []);
    } else if (current !== undefined) {
      sections.get(current).push(line);
    }
  }
  return new Map([...sections].map(([name, lines]) => [name, lines.join('\n').trim()]));
}

/** The branch's last segment, as a slug: `feat/slack-edit-delete` → `slack-edit-delete`. */
export function branchSlug(headRef) {
  const last =
    String(headRef ?? '')
      .split('/')
      .pop() ?? '';
  return last
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The three versions that can follow `current`: a patch, a minor or a major step, by semver. */
export function nextVersions(current) {
  const [major, minor, patch] = String(current).split('.').map(Number);
  return {
    patch: `${major}.${minor}.${patch + 1}`,
    minor: `${major}.${minor + 1}.0`,
    major: `${major + 1}.0.0`,
  };
}

const isCode = (path) => /^packages\/[^/]+\/src\//.test(path) || /^scripts\//.test(path);
const isPackageCode = (path) => /^packages\/[^/]+\/src\//.test(path);
const isTest = (path) => /^packages\/[^/]+\/test\//.test(path) || /^test\//.test(path);
const isDocs = (path) =>
  /^docs\//.test(path) ||
  /^skills\//.test(path) ||
  /(^|\/)README\.md$/.test(path) ||
  ['SECURITY.md', 'CONTRIBUTING.md', 'AGENTS.md'].includes(path);

/**
 * What the pull request is missing, as sentences addressed to its submitter. Empty when it carries everything.
 *
 * `files` are the changed paths; `currentVersion` is the root `package.json` version on the base branch.
 */
export function checkPullRequest({ body, headRef, files, currentVersion }) {
  const missing = [];
  const sections = sectionsOf(body);

  for (const name of SECTIONS) {
    if (!sections.get(name)) missing.push(`The "${name}" section is empty or missing: fill it in from the template.`);
  }

  const slug = branchSlug(headRef);
  const proposed = VERSION.exec(sections.get('Proposed version') ?? '');
  let proposal;
  if (!proposed) {
    missing.push(
      `A proposed version, as \`X.Y.Z-${slug || '<branch-slug>'}\` under "Proposed version", with why it is a patch, a minor or a major change.`,
    );
  } else {
    const [, major, minor, patch, versionSlug] = proposed;
    const number = `${major}.${minor}.${patch}`;
    const next = nextVersions(currentVersion);
    const step = Object.entries(next).find(([, version]) => version === number)?.[0];
    proposal = { version: proposed[0], number, slug: versionSlug, step };
    if (!step) {
      missing.push(
        `The proposed version \`${proposed[0]}\` is not one step on from ${currentVersion}: a patch is ${next.patch}, a minor ${next.minor}, a major ${next.major}.`,
      );
    }
    if (slug && versionSlug !== slug) {
      missing.push(
        `The proposed version's slug should be the branch's: \`${number}-${slug}\`, not \`${proposed[0]}\`.`,
      );
    }
  }

  const provenance = sections.get('Provenance') ?? '';
  for (const label of PROVENANCE_LABELS) {
    // Spaces only, never \s: a label left empty must not borrow the next line's words.
    const line = new RegExp(`^[ \\t]*[-*]?[ \\t]*\\**${label}:?\\**:?[ \\t]*(.*)$`, 'im').exec(provenance);
    if (!line?.[1].replace(/[*_`]/g, '').trim()) {
      missing.push(`Under "Provenance", **${label}:** says nothing — write what applies, or "none" and why.`);
    }
  }

  for (const box of withoutComments(body ?? '').matchAll(/^\s*[-*]\s+\[ \]\s+(.+)$/gm)) {
    missing.push(
      `A box is not ticked: "${box[1].trim()}". Do it and tick it, or say in the box why it does not apply.`,
    );
  }

  const changed = files ?? [];
  if (changed.some(isCode) && !changed.some(isTest)) {
    missing.push('Tests: the code changed and no test did. Add the tests that prove the change.');
  }
  // A change nobody will notice says so, with its reason, rather than writing an entry nobody needs.
  const noChangelog = /^[ \t]*[-*]?[ \t]*No changelog:[ \t]*\S/im.test(withoutComments(body ?? ''));
  if (changed.some(isPackageCode) && !changed.includes('CHANGELOG.md') && !noChangelog) {
    missing.push(
      'A `CHANGELOG.md` entry under `## Unreleased`, saying what changes for the person using it — or, when nobody will notice, a line `No changelog: <why>` in the description.',
    );
  }
  if ((changed.some(isPackageCode) || changed.includes('capabilities.json')) && !changed.some(isDocs)) {
    missing.push('Documentation: a package changed and no README, guide, reference page or skill did.');
  }

  return { missing, proposal };
}

/** The one comment the check keeps on the pull request. */
export function commentFor(author, { missing, proposal }, repo = 'crissmoldovan/agent-communications') {
  if (missing.length === 0) {
    return `${MARKER}\nEverything this repository asks of a pull request is here${proposal ? ` (proposed version \`${proposal.version}\`, a ${proposal.step})` : ''}. Thank you.`;
  }
  return [
    MARKER,
    `@${author}, thanks for this. Before it can be reviewed and merged, it needs the following — [CONTRIBUTING.md](https://github.com/${repo}/blob/main/CONTRIBUTING.md#what-every-pull-request-carries) says why each one matters:`,
    '',
    ...missing.map((item) => `- ${item}`),
    '',
    'Edit the description or push to the branch, and this check runs again. Nobody will fill these in for you.',
  ].join('\n');
}

async function github(path, token, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function runInWorkflow() {
  const token = process.env.GITHUB_TOKEN;
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  const repo = event.repository.full_name;
  if (pr.user.type === 'Bot') {
    console.log(`${pr.user.login} is a bot: its version and provenance are the maintainer's to add.`);
    return 0;
  }
  const files = [];
  for (let page = 1; ; page += 1) {
    const batch = await github(`/repos/${repo}/pulls/${pr.number}/files?per_page=100&page=${page}`, token);
    files.push(...batch.map((file) => file.filename));
    if (batch.length < 100) break;
  }
  const { version: currentVersion } = JSON.parse(
    await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  );
  const result = checkPullRequest({ body: pr.body, headRef: pr.head.ref, files, currentVersion });
  const body = commentFor(pr.user.login, result, repo);

  const comments = await github(`/repos/${repo}/issues/${pr.number}/comments?per_page=100`, token);
  const ours = comments.find((comment) => comment.user.type === 'Bot' && comment.body.startsWith(MARKER));
  if (ours) {
    if (ours.body !== body) {
      await github(`/repos/${repo}/issues/comments/${ours.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      });
    }
  } else if (result.missing.length > 0) {
    await github(`/repos/${repo}/issues/${pr.number}/comments`, token, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }
  console.log(body);
  return result.missing.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--github')) {
  process.exitCode = await runInWorkflow();
}
