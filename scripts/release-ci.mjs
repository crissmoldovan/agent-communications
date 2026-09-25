#!/usr/bin/env node
/**
 * The parts of the release workflow worth testing, kept out of YAML so they can be.
 *
 *   node scripts/release-ci.mjs preflight          # every package trusts this workflow, or nothing is published
 *   node scripts/release-ci.mjs notes 0.4.1        # prints the CHANGELOG section for a version, or fails
 *
 * Both run in `.github/workflows/release.yml`, and `test/release-packages.test.mjs` runs both against a fake
 * registry and a scratch changelog.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGES, SCOPE } from './packages.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const [command, ...rest] = process.argv.slice(2);

/**
 * Proves npm trusted publishing works for every package before any of them is published.
 *
 * **Why it exists.** Each package on npm has its own trusted-publisher configuration, and nothing public says whether
 * one is set. When it is missing, pnpm's publish only prints "Skipped OIDC" and falls back to a registry token this
 * workflow deliberately does not have, so that one package's PUT is refused — after the packages before it in the
 * list have gone out. For `@agentcomms/slack`, last in the list and first published by hand, that would have left
 * core, gmail and gmail-mcp at the new version and slack not, with no way to finish the release at that version.
 *
 * **How.** Exactly what the publish itself does, minus the publish: ask GitHub for an ID token with the audience
 * `npm:<registry host>`, then POST it to `/-/npm/v1/oidc/token/exchange/package/<escaped name>`. npm answers 200 with
 * a short-lived publish token only if that package names this repository, workflow file and environment as its
 * trusted publisher; otherwise it refuses. The token is read to confirm it exists and then dropped: it is never
 * printed, written or kept, and it expires on its own. A fresh ID token is asked for per package, because npm may
 * refuse an ID token it has already exchanged, and this must not be the thing that spends the publish's one.
 */
async function preflight() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    fail(
      'no GitHub OIDC request credentials in the environment. The publish job needs `permissions: id-token: write`; ' +
        'without it npm trusted publishing cannot work either, so nothing would publish.',
    );
  }
  const registry = new URL(process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org');
  const audience = `npm:${registry.hostname}`;

  const refused = [];
  for (const name of PACKAGES) {
    const full = `${SCOPE}/${name}`;
    const verdict = await exchange({ requestUrl, requestToken, audience, registry, full });
    if (verdict === true) {
      console.log(`  ✓ ${full} trusts this workflow`);
    } else {
      console.log(`  ✗ ${full}: ${verdict}`);
      refused.push(full);
    }
  }
  if (refused.length > 0) {
    fail(
      `${refused.join(', ')} ${refused.length === 1 ? 'has' : 'have'} no trusted publisher for this workflow; ` +
        'nothing was published. The package owner adds one on npmjs.com → the package → Settings → Trusted ' +
        'publishing (this repository, `release.yml`, environment `release`), then re-runs this job.',
    );
  }
  console.log(`All ${PACKAGES.length} packages accept this workflow's identity.`);
}

/** One package's exchange. Returns true, or a sentence saying why not; never the token. */
async function exchange({ requestUrl, requestToken, audience, registry, full }) {
  // Transient failures (the network, a 5xx) are retried: failing here costs nothing but a re-run, yet a flaky answer
  // should not be what stops a release. A 4xx is npm's verdict, and is not retried.
  let last = 'no answer';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const idUrl = new URL(requestUrl);
      idUrl.searchParams.set('audience', audience);
      const idResponse = await fetch(idUrl, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${requestToken}` },
      });
      if (!idResponse.ok) {
        last = `GitHub refused an ID token (HTTP ${idResponse.status})`;
        if (idResponse.status < 500) return last;
        continue;
      }
      const idToken = (await idResponse.json())?.value;
      if (typeof idToken !== 'string' || idToken === '') return 'GitHub answered without an ID token';

      const escaped = full.replace('/', '%2f');
      const response = await fetch(new URL(`/-/npm/v1/oidc/token/exchange/package/${escaped}`, registry), {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${idToken}`, 'Content-Length': '0' },
        body: '',
      });
      const body = await response.json().catch(() => null);
      if (response.ok) {
        // A 200 without a token is not a pass: pnpm treats it as a failed exchange too.
        return typeof body?.token === 'string' && body.token !== '' ? true : 'npm answered 200 without a token';
      }
      // npm's refusal carries a message, not a secret; it is what says which claim did not match.
      const said = typeof body?.message === 'string' ? `: ${body.message.slice(0, 200)}` : '';
      last = `npm refused the exchange (HTTP ${response.status})${said}`;
      if (response.status < 500) return last;
    } catch (error) {
      last = `could not reach the registry or GitHub (${error?.cause?.code ?? error?.message ?? error})`;
    }
  }
  return last;
}

/**
 * Prints the changelog section for one version: the lines after `## <version>` up to the next `## `.
 *
 * Used twice. The tag gate runs it **before** publishing, so a tag with no entry stops there rather than publishing and
 * then failing to make its release page. The GitHub release job runs it again for the body.
 */
async function notes(version) {
  if (!version) fail('usage: release-ci.mjs notes <version>');
  const changelog = await readFile(process.env.RELEASE_CHANGELOG || join(ROOT, 'CHANGELOG.md'), 'utf8');
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) fail(`CHANGELOG.md has no "## ${version}" section. Write the entry before tagging.`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const body = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
  if (!body) fail(`CHANGELOG.md has a "## ${version}" heading with nothing under it.`);
  process.stdout.write(`${body}\n`);
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

if (command === 'preflight') await preflight();
else if (command === 'notes') await notes(rest[0]);
else fail('usage: release-ci.mjs preflight | notes <version>');
