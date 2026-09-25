import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PACKAGES } from '../scripts/packages.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

/**
 * Every publishable package is released, by every path that releases, in an order that installs.
 *
 * The release publishes from an explicit, ordered list, and the order is load-bearing: a consumer installing `gmail`
 * must find the exact `core` it pins already on the registry. So the list cannot simply be derived — but it can be
 * *checked*, and it has to be, because it was not: 0.4.0 published three packages and reported success while
 * `@agentcomms/slack` — added in that very release — was missing from the loop. Then, with the workflow fixed,
 * `scripts/release.mjs` still carried its own copy that said three.
 *
 * That was the fifth time in one change that a hand-written list of things went stale: `sync-skills.mjs` and the
 * plugin-manifest test both enumerated skills by a `gmail-` prefix, `sync-versions.mjs` did the same for
 * compatibility lines, and the release made the same shape of mistake twice with packages. The pattern that works is
 * one explicit list, a test that it is complete, and a test that everything which walks the packages reads it.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const exec = promisify(execFile);

/** Runs a script and returns its exit status and output; a refusal is an answer, not a thrown error. */
async function runScript(script, args, options = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [script, ...args], { encoding: 'utf8', ...options });
    return { status: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { status: error.code, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

async function manifests() {
  const dirs = (await readdir(join(ROOT, 'packages'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const found = new Map();
  for (const dir of dirs) {
    const manifest = JSON.parse(await readFile(join(ROOT, 'packages', dir, 'package.json'), 'utf8'));
    if (manifest.private === true) continue;
    assert.ok(manifest.name?.startsWith('@agentcomms/'), `${dir} has an unexpected package name`);
    assert.equal(manifest.name, `@agentcomms/${dir}`, 'the list names directories, so each must match its package');
    found.set(dir, manifest);
  }
  return found;
}

test('the shared list names every publishable package, and nothing else', async () => {
  const publishable = [...(await manifests()).keys()];
  assert.ok(publishable.length > 0, 'no publishable packages found — the discovery is wrong');
  for (const name of publishable) {
    assert.ok(PACKAGES.includes(name), `@agentcomms/${name} is publishable but scripts/packages.mjs never names it`);
  }
  // Nothing in the list that is not a real package, which would make the confirm step hang on a 404.
  for (const name of PACKAGES) {
    assert.ok(
      publishable.includes(name),
      `scripts/packages.mjs names @agentcomms/${name}, which is not a package here`,
    );
  }
  assert.equal(new Set(PACKAGES).size, PACKAGES.length, 'a package listed twice would be published twice');
});

test('the shared list is in an order that installs: every package after what it depends on', async () => {
  const found = await manifests();
  for (const [index, name] of PACKAGES.entries()) {
    const manifest = found.get(name);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (!dependency.startsWith('@agentcomms/')) continue;
        const at = PACKAGES.indexOf(dependency.slice('@agentcomms/'.length));
        assert.ok(at !== -1 && at < index, `@agentcomms/${name} depends on ${dependency}, so it must come after it`);
      }
    }
  }
});

test('running the list prints it, which is how the workflow reads it', async () => {
  const { status, stdout } = await runScript(join(ROOT, 'scripts', 'packages.mjs'), []);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), PACKAGES.join(' '));
});

/*
 * Every consumer reads the list rather than keeping a copy.
 *
 * Checked as text, because the consumers are a workflow and scripts that publish: neither can be run here. What is
 * asserted is the property that failed twice — a literal list of package names — together with the line that proves
 * the file reads the shared one instead.
 */
const LITERAL_LIST = /['"]core['"]\s*,\s*['"]gmail['"]|\bcore\s+gmail\b/;

test('the release workflow reads the shared list in every loop', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.doesNotMatch(workflow, LITERAL_LIST, 'the workflow carries its own package list again');

  const loops = [...workflow.matchAll(/for package in ([^;]+); do/g)].map((match) => match[1].trim());
  assert.ok(loops.length >= 2, 'expected a publish loop and a confirm loop');
  for (const loop of loops) {
    assert.match(loop, /^\$(packages|missing)$/, `a loop iterates something other than the shared list: ${loop}`);
  }
  assert.match(workflow, /packages=\$\(node scripts\/packages\.mjs\)/, 'the publish loop reads the shared list');
  assert.match(workflow, /missing=\$\(node scripts\/packages\.mjs\)/, 'the confirm loop reads the shared list');
  // An empty print would loop zero times and finish green, so each read is followed by a refusal of nothing.
  assert.equal(
    [...workflow.matchAll(/\[ -n "\$(packages|missing)" \] \|\| \{/g)].length,
    2,
    'each read of the list refuses an empty one',
  );
});

test('the local release script, sync-versions and the package verifier read the shared list', async () => {
  for (const script of ['release.mjs', 'sync-versions.mjs', 'verify-package.mjs', 'release-ci.mjs']) {
    const source = await readFile(join(ROOT, 'scripts', script), 'utf8');
    assert.match(source, /from '\.\/packages\.mjs'/, `scripts/${script} does not read scripts/packages.mjs`);
    assert.doesNotMatch(source, LITERAL_LIST, `scripts/${script} carries its own package list`);
  }
  const root = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(root.scripts['verify:packages'], 'node scripts/verify-package.mjs --all');
});

// ── The publish job's shape ──────────────────────────────────────────────────────────────────────────────────────

/** Where `marker` first appears in the workflow; failing, rather than returning -1, when it does not. */
function stepIndex(workflow, marker) {
  const at = workflow.indexOf(marker);
  assert.notEqual(at, -1, `no step matching ${marker}`);
  return at;
}

test('the OIDC preflight runs before anything is published', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const preflight = stepIndex(workflow, 'node scripts/release-ci.mjs preflight');
  const publish = stepIndex(workflow, 'pnpm --filter "@agentcomms/$package" publish');
  assert.ok(preflight < publish, 'the preflight must come before the first publish, or it proves nothing in time');
  // It must be in the publish job, which alone holds `id-token: write` and the `release` environment the trusted
  // publishers name. In another job the exchange would fail for every package, or pass for the wrong identity.
  const publishJob = workflow.indexOf('\n  publish:\n');
  const nextJob = workflow.indexOf('\n  github-release:\n');
  assert.ok(publishJob < preflight && preflight < nextJob, 'the preflight runs inside the publish job');
});

test('a re-run skips what is already published, so a partial release can be finished', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const loop = /- name: publish\n\s+run: \|\n([\s\S]*?)\n\n/.exec(workflow)?.[1] ?? '';
  const view = loop.indexOf('npm view "@agentcomms/$package@$version" version');
  const skip = loop.search(/if \[ "\$existing" = "\$version" \]; then/);
  const publish = loop.indexOf('pnpm --filter "@agentcomms/$package" publish');
  assert.ok(view !== -1 && skip !== -1, 'the publish loop no longer asks the registry what is already there');
  assert.ok(view < skip && skip < publish, 'the check must decide whether the publish runs');
  assert.match(loop.slice(skip, publish), /else\s*$/, 'the publish must be the else branch of that check');
});

test('the local release script publishes a prerelease under next, as the workflow does', async () => {
  const script = await readFile(join(ROOT, 'scripts', 'release.mjs'), 'utf8');
  const rule = /const distTag = version\.includes\('-'\) \? 'next' : 'latest';/.exec(script);
  assert.ok(rule, 'the script no longer chooses the dist-tag from the version');
  const publish = /runLoud\('pnpm', \[([^\]]*'publish'[^\]]*)\]\)/.exec(script)?.[1] ?? '';
  assert.match(publish, /'--tag',\s*distTag/, 'every publish must name the tag, or npm moves `latest`');
  assert.ok(rule.index < script.indexOf(publish), 'the tag is decided before anything is sent');
});

test('the registry confirmation has room for the lag seen on real releases', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const attempts = Number(/for attempt in \$\(seq 1 (\d+)\)/.exec(workflow)?.[1]);
  const pause = Number(/sleep (\d+)\n\s+done/.exec(workflow)?.[1]);
  // 0.4.0's last package became visible after about four minutes; the budget must be well past that.
  assert.ok(attempts * pause >= 600, `the confirm step gives up after ${attempts * pause}s`);
});

test('a tag gets its GitHub release from the changelog, after the publish is confirmed', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const job = workflow.slice(stepIndex(workflow, '\n  github-release:\n'));
  assert.match(job, /needs: publish/, 'it must wait for the publish job, whose last step confirms the registry');
  assert.match(job, /if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(job, /contents: write/);
  assert.match(job, /node scripts\/release-ci\.mjs notes "\$version"/, 'the body is the changelog section');
  assert.match(job, /gh release view/, 'a re-run leaves an existing release alone');
  assert.match(job, /gh release create "\$GITHUB_REF_NAME"[^\n]*--verify-tag/);

  // And the tag gate reads the same section before anything is published, so a missing entry stops the release
  // with nothing sent rather than after the packages are out.
  const gate = workflow.indexOf('node scripts/release-ci.mjs notes "$tag"');
  assert.ok(gate !== -1 && gate < stepIndex(workflow, 'node scripts/release-ci.mjs preflight'));
});

// ── The OIDC preflight, against a fake GitHub and a fake registry ────────────────────────────────────────────────

/**
 * One loopback server playing both parts. GitHub hands out numbered ID tokens; the registry mints a publish token
 * for every package except those in `untrusted`, and records which ID token each exchange carried.
 */
async function fakeOidc({ untrusted = [], emptyToken = [] } = {}) {
  let issued = 0;
  const exchanges = [];
  const audiences = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/id-token') {
      assert.equal(request.headers.authorization, 'Bearer fake-request-token');
      audiences.push(url.searchParams.get('audience'));
      issued += 1;
      response.end(JSON.stringify({ value: `id-token-${issued}` }));
      return;
    }
    const match = /^\/-\/npm\/v1\/oidc\/token\/exchange\/package\/(.+)$/.exec(url.pathname);
    if (match && request.method === 'POST') {
      const name = decodeURIComponent(match[1]);
      exchanges.push({ name, raw: match[1], idToken: request.headers.authorization });
      if (untrusted.includes(name)) {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: `no trusted publisher configured for ${name}` }));
        return;
      }
      const token = emptyToken.includes(name) ? '' : `minted-publish-token-${exchanges.length}`;
      response.end(JSON.stringify({ token }));
      return;
    }
    response.statusCode = 500;
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    exchanges,
    audiences,
    env: {
      ...process.env,
      ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${port}/id-token?api-version=2.0`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake-request-token',
      NPM_CONFIG_REGISTRY: `http://127.0.0.1:${port}/`,
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const CI = join(ROOT, 'scripts', 'release-ci.mjs');

test('the preflight passes only when every package exchanges, and never prints a token', async () => {
  const fake = await fakeOidc();
  try {
    const result = await runScript(CI, ['preflight'], { env: fake.env });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      fake.exchanges.map((exchange) => exchange.name),
      PACKAGES.map((name) => `@agentcomms/${name}`),
      'every package, in order, is asked',
    );
    // The name is escaped the way npm's own client escapes it, or the registry answers for a different path.
    assert.ok(fake.exchanges.every((exchange) => exchange.raw.startsWith('@agentcomms%2f')));
    // A fresh ID token per exchange: npm may refuse one it has seen, and the publish needs its own.
    assert.equal(new Set(fake.exchanges.map((exchange) => exchange.idToken)).size, PACKAGES.length);
    assert.ok(
      fake.audiences.every((audience) => audience === 'npm:127.0.0.1'),
      'the audience names the registry',
    );
    assert.doesNotMatch(result.stdout + result.stderr, /minted-publish-token|id-token-\d/);
  } finally {
    await fake.close();
  }
});

test('the preflight fails, naming the package, when one has no trusted publisher', async () => {
  const fake = await fakeOidc({ untrusted: ['@agentcomms/slack'] });
  try {
    const result = await runScript(CI, ['preflight'], { env: fake.env });
    assert.equal(result.status, 1, 'a package npm refuses must stop the release before any publish');
    assert.match(result.stderr, /@agentcomms\/slack has no trusted publisher for this workflow; nothing was published/);
    assert.match(result.stdout, /✗ @agentcomms\/slack: npm refused the exchange \(HTTP 404\): no trusted publisher/);
    assert.doesNotMatch(result.stderr, /@agentcomms\/core has/, 'only the package that failed is named');
    assert.doesNotMatch(result.stdout + result.stderr, /minted-publish-token/);
  } finally {
    await fake.close();
  }
});

test('the preflight does not count a 200 without a token as trust', async () => {
  const fake = await fakeOidc({ emptyToken: ['@agentcomms/gmail'] });
  try {
    const result = await runScript(CI, ['preflight'], { env: fake.env });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /✗ @agentcomms\/gmail: npm answered 200 without a token/);
  } finally {
    await fake.close();
  }
});

test('the preflight refuses without the OIDC permission, since the publish could not work either', async () => {
  const env = { ...process.env };
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const result = await runScript(CI, ['preflight'], { env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /id-token: write/);
});

// ── The changelog section ────────────────────────────────────────────────────────────────────────────────────────

test('the release notes are the changelog section for the version, and a missing one refuses', async () => {
  const dir = await tempDir('release-notes-');
  const changelog = join(dir, 'CHANGELOG.md');
  await writeFile(
    changelog,
    '# Changelog\n\nIntro.\n\n## 1.2.0\n\n**New.** A thing.\n\n### Detail\n\nMore.\n\n## 1.1.0\n\nOlder.\n\n## 1.0.0\n',
  );
  const env = { ...process.env, RELEASE_CHANGELOG: changelog };

  const found = await runScript(CI, ['notes', '1.2.0'], { env });
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout, '**New.** A thing.\n\n### Detail\n\nMore.\n', 'a `###` heading is part of the section');

  const last = await runScript(CI, ['notes', '1.1.0'], { env });
  assert.equal(last.stdout, 'Older.\n');

  // `1.2` is a prefix of `1.2.0`: matching a heading by prefix would publish the wrong release's notes.
  const prefix = await runScript(CI, ['notes', '1.2'], { env });
  assert.equal(prefix.status, 1);

  const missing = await runScript(CI, ['notes', '9.9.9'], { env });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no "## 9\.9\.9" section/);

  const empty = await runScript(CI, ['notes', '1.0.0'], { env });
  assert.equal(empty.status, 1, 'a heading with nothing under it is not an entry');
});

test('the repository changelog has a section for the version it declares', async () => {
  const root = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const result = await runScript(CI, ['notes', root.version]);
  // Before a release the new version's entry is written as the version is bumped, so both land in one commit.
  assert.equal(result.status, 0, `CHANGELOG.md has no section for ${root.version}: ${result.stderr}`);
});

// ── sync-versions, on a copy ─────────────────────────────────────────────────────────────────────────────────────

test('sync-versions bumps every skill, Slack included, and --check catches one left behind', async () => {
  const dir = await tempDir('sync-versions-');
  for (const path of ['package.json', 'skills', '.claude-plugin', 'gemini-extension.json', 'bin', 'scripts']) {
    await cp(join(ROOT, path), join(dir, path), { recursive: true });
  }
  for (const name of PACKAGES) {
    await mkdir(join(dir, 'packages', name), { recursive: true });
    await cp(join(ROOT, 'packages', name, 'package.json'), join(dir, 'packages', name, 'package.json'));
  }
  const rootManifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  const old = rootManifest.version;
  const next = `${old}-bump.1`;
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({ ...rootManifest, version: next }, null, 2)}\n`);

  const sync = join(dir, 'scripts', 'sync-versions.mjs');
  const written = await runScript(sync, []);
  assert.equal(written.status, 0, written.stderr);

  const skills = (await readdir(join(dir, 'skills'), { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith('_'),
  );
  assert.ok(
    skills.some((entry) => entry.name.startsWith('slack-')),
    'the fixture has no Slack skill to check',
  );
  for (const entry of skills) {
    const source = await readFile(join(dir, 'skills', entry.name, 'SKILL.md'), 'utf8');
    assert.match(source, new RegExp(`^compatibility: "@agentcomms/[\\w-]+@${next.replace(/\./g, '\\.')}"$`, 'm'));
    assert.ok(!source.includes(`@${old}"`), `skills/${entry.name} still names ${old}`);
  }
  assert.equal((await runScript(sync, ['--check'])).status, 0);

  // Put one Slack skill back, as 0.4.1 would have left it: --check is what the tag gate runs, and it must refuse.
  const stale = join(dir, 'skills', 'slack-reading', 'SKILL.md');
  await writeFile(
    stale,
    (await readFile(stale, 'utf8')).replace(`@agentcomms/slack@${next}`, `@agentcomms/slack@${old}`),
  );
  const check = await runScript(sync, ['--check']);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /skills\/slack-reading\/SKILL\.md: the compatibility line is out of date/);
});
