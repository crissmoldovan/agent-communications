import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tempDir } from './helpers/temp-dir.mjs';

/**
 * A pushed tag reuses a green dry run of its exact tree (`scripts/release-ci.mjs verified`, the `verified` job of
 * `.github/workflows/release.yml`). What may never happen is the reuse of a run that did not verify these very files:
 * so a match needs a dispatched run, concluded success, whose head commit has this tree; and anything else, an API
 * error included, answers none, and the verify legs run.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const SCRIPT = join(ROOT, 'scripts', 'release-ci.mjs');
const REPOSITORY = 'owner/agent-communications';

async function git(cwd, ...args) {
  const { stdout } = await run('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
  });
  return stdout.trim();
}

/**
 * A scratch repository holding two commits with one tree, as a pull request's head and the merge commit made of it
 * with nothing else on `main`, and a third with another tree.
 */
async function repository() {
  const root = await tempDir('release-verified-');
  await git(root, 'init', '--quiet');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'file.txt'), 'the release\n');
  await git(root, 'add', 'file.txt');
  await git(root, 'commit', '--quiet', '-m', 'head');
  const head = await git(root, 'rev-parse', 'HEAD');
  await git(root, 'commit', '--quiet', '--allow-empty', '-m', 'merge');
  const merge = await git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'file.txt'), 'something else\n');
  await git(root, 'commit', '--quiet', '-am', 'other');
  const other = await git(root, 'rev-parse', 'HEAD');
  const tree = (sha) => git(root, 'rev-parse', `${sha}^{tree}`);
  return { root, head, merge, other, trees: { [head]: await tree(head), [other]: await tree(other) } };
}

/** GitHub's API, for `runs` and the trees of the commits named; `status` answers every request with that status. */
async function fakeApi({ runs, trees, status }) {
  const asked = [];
  const server = createServer((request, response) => {
    asked.push(request.url);
    const reply = (code, body) => {
      response.writeHead(code, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (status) return reply(status, { message: 'no' });
    if (request.url.startsWith(`/repos/${REPOSITORY}/actions/workflows/release.yml/runs?`)) {
      return reply(200, { total_count: runs.length, workflow_runs: runs });
    }
    const commit = /^\/repos\/[^/]+\/[^/]+\/git\/commits\/([0-9a-f]{40})$/.exec(request.url)?.[1];
    if (commit && trees[commit]) return reply(200, { sha: commit, tree: { sha: trees[commit] } });
    return reply(404, { message: 'Not Found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, asked, close: () => server.close() };
}

/** Runs `release-ci.mjs verified <commit>` in `root`; what it printed, and the `run` it wrote to $GITHUB_OUTPUT. */
async function verified(root, commit, api) {
  const output = join(root, 'github-output');
  await writeFile(output, '');
  const { stdout } = await run(process.execPath, [SCRIPT, 'verified', commit], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_API_URL: api,
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_TOKEN: 'fake-token-for-tests',
      GITHUB_OUTPUT: output,
    },
  });
  const written = (await readFile(output, 'utf8')).trim();
  assert.match(written, /^run=\d*$/, 'one run line, a run id or nothing');
  return { stdout, run: written.slice('run='.length) };
}

const dispatched = (id, headSha, extra = {}) => ({
  id,
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  head_sha: headSha,
  html_url: `https://github.example.test/runs/${id}`,
  ...extra,
});

test('a tag reuses the green dry run whose head has its exact tree', async () => {
  const repo = await repository();
  const api = await fakeApi({ runs: [dispatched(7, repo.head)], trees: repo.trees });
  try {
    const answer = await verified(repo.root, repo.merge, api.url);
    assert.equal(answer.run, '7');
    assert.match(answer.stdout, /dry run 7 verified this exact tree/);
    // It asked only for dispatched, successful runs, and for the dry run's own commit.
    assert.match(api.asked[0], /event=workflow_dispatch&status=success/);
    assert.ok(api.asked.includes(`/repos/${REPOSITORY}/git/commits/${repo.head}`));
  } finally {
    api.close();
  }
});

test('a dry run of the tagged commit itself counts, with no tree to ask for', async () => {
  const repo = await repository();
  const api = await fakeApi({ runs: [dispatched(8, repo.merge)], trees: {} });
  try {
    assert.equal((await verified(repo.root, repo.merge, api.url)).run, '8');
  } finally {
    api.close();
  }
});

test('a run of another tree, a failed or cancelled one, or a push run is no reason to skip the legs', async () => {
  const repo = await repository();
  const runs = [
    dispatched(1, repo.other),
    dispatched(2, repo.head, { conclusion: 'failure' }),
    dispatched(3, repo.head, { conclusion: 'cancelled' }),
    dispatched(4, repo.head, { event: 'push' }),
    dispatched(5, 'not-a-commit'),
  ];
  const api = await fakeApi({ runs, trees: repo.trees });
  try {
    const answer = await verified(repo.root, repo.merge, api.url);
    assert.equal(answer.run, '');
    assert.match(answer.stdout, /no green dry run verified this tree, [0-9a-f]{40}: the verify legs run/);
  } finally {
    api.close();
  }
});

test('when the API cannot be asked, or refuses, the legs run', async () => {
  const repo = await repository();
  for (const status of [403, 500]) {
    const api = await fakeApi({ runs: [], trees: {}, status });
    try {
      const answer = await verified(repo.root, repo.merge, api.url);
      assert.equal(answer.run, '', `status ${status}`);
      assert.match(answer.stdout, /could not ask which dry runs passed .*: the verify legs run/);
    } finally {
      api.close();
    }
  }
  // Nothing listening at all.
  const gone = await fakeApi({ runs: [], trees: {} });
  gone.close();
  assert.equal((await verified(repo.root, repo.merge, gone.url)).run, '');
});

test('the workflow skips the verify legs only on a match, and publishes after them or after that match alone', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const block = (key) => {
    const start = workflow.indexOf(`\n  ${key}:\n`);
    assert.ok(start >= 0, `there is a ${key} job`);
    const next = /\n {2}[a-z][\w-]*:\n/g;
    next.lastIndex = start + 1;
    return workflow.slice(start, next.exec(workflow)?.index ?? workflow.length);
  };
  const lookup = block('verified');
  // Read-only, and only for a pushed tag: a dispatched run, a dry run itself, always runs its legs.
  assert.match(lookup, /permissions:\n {6}contents: read\n {6}actions: read # [^\n]*\n {4}outputs:/);
  assert.doesNotMatch(lookup, /id-token|environment:|secrets\.|write/);
  assert.match(lookup, /if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(lookup, /run: node scripts\/release-ci\.mjs verified "\$GITHUB_SHA"/);
  assert.match(lookup, /outputs:\n {6}run: \$\{\{ steps\.lookup\.outputs\.run \}\}/);

  const verify = block('verify');
  assert.match(verify, /\n {4}needs: verified\n {4}if: needs\.verified\.outputs\.run == ''\n/);

  const publish = block('publish');
  const condition = /\n {4}if: >-\n((?: {6}.*\n)+)/.exec(publish)?.[1].replace(/\s+/g, ' ').trim();
  assert.equal(
    condition,
    "${{ !cancelled() && inputs.dry-run != true && needs.verified.result == 'success' " +
      "&& needs.old-node.result == 'success' && needs.browser.result == 'success' && needs.laya.result == 'success' " +
      "&& (needs.verify.result == 'success' || (needs.verify.result == 'skipped' && needs.verified.outputs.run != '')) }}",
  );
});
