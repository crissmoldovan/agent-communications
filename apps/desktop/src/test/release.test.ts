// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The desktop app's CI, its release workflow and the owner's two release scripts (desktop design DA8, DA15; plan
 * Task 11). The scripts are read, never run: they sign, notarise and publish from the owner's Mac, and no agent and no
 * test runs them. `bash -n` only parses them.
 */

const APP = fileURLToPath(new URL('../../', import.meta.url));
const ROOT = join(APP, '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const DESKTOP_YML = '.github/workflows/desktop.yml';
/** The Rust `apps/desktop/src-tauri/rust-toolchain.toml` pins. */
const PINNED_RUST = /^channel = "([^"]+)"$/m.exec(read('apps/desktop/src-tauri/rust-toolchain.toml'))?.[1] ?? 'none';
const RELEASE_YML = '.github/workflows/desktop-release.yml';
const RELEASE_SH = 'apps/desktop/scripts/release-desktop.sh';
const PUBLISH_SH = 'apps/desktop/scripts/publish-desktop.sh';

/**
 * The lines of `key:` at `indent` spaces, through every line indented deeper, without the blank lines and comments
 * that trail it.
 */
function block(text: string, key: string, indent = 0): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${' '.repeat(indent)}${key}:`));
  if (start === -1) return '';
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const depth = line.length - line.trimStart().length;
    if (line.trim() !== '' && !line.trimStart().startsWith('#') && depth <= indent) break;
    body.push(line);
  }
  while (body.length > 0 && /^\s*(?:#.*)?$/.test(body.at(-1) ?? '')) body.pop();
  return [lines[start], ...body].join('\n');
}

/** Where each of `needles` first appears in `text`, failing for any that is missing. */
function positions(text: string, needles: string[]): number[] {
  return needles.map((needle) => {
    const at = text.indexOf(needle);
    expect(at, `missing: ${needle}`).toBeGreaterThan(-1);
    return at;
  });
}

const ascending = (numbers: number[]): boolean => numbers.every((n, i) => i === 0 || (numbers[i - 1] ?? 0) < n);

/** Every action a workflow uses is pinned to a full commit, as phase C's are. */
function expectPinnedActions(workflow: string): void {
  const uses = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((match) => match[1] ?? '');
  expect(uses.length).toBeGreaterThan(0);
  for (const action of uses) {
    if (action.startsWith('./')) continue;
    expect(action, `${action} is not pinned to a commit`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  }
}

/** Every `gh release create` or `gh release edit` line, continuations joined. */
function releaseCommands(text: string): string[] {
  return text
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .filter((line) => /\bgh release (?:create|edit)\b/.test(line) && !line.trimStart().startsWith('#'));
}

function expectNeverLatest(text: string): void {
  const commands = releaseCommands(text);
  expect(commands.length).toBeGreaterThan(0);
  for (const command of commands) expect(command, command).toContain('--latest=false');
  expect(text).not.toMatch(/--latest(?:=true)?(?=\s|$)/m);
  expect(text).not.toMatch(/make_latest/);
  // The updater skips a prerelease, so neither the workflow nor the scripts make one.
  expect(text).not.toMatch(/--prerelease(?!=false)/);
}

describe('the desktop workflows', () => {
  it('desktop.yml runs on PRs touching apps/desktop, on four legs, with every gate', () => {
    const workflow = read(DESKTOP_YML);
    const on = block(workflow, 'on');
    const paths = [
      "'apps/desktop/**'",
      "'.github/workflows/desktop*.yml'",
      "'pnpm-lock.yaml'",
      "'pnpm-workspace.yaml'",
    ];
    for (const event of ['pull_request', 'push']) {
      const trigger = block(on, event, 2);
      for (const path of paths) expect(trigger, `${event} on ${path}`).toContain(`- ${path}`);
    }
    expect(block(on, 'push', 2)).toMatch(/branches: \[main\]/);
    expect(on).toMatch(/^ {2}workflow_call: \{\}$/m);

    expect(block(workflow, 'permissions')).toBe('permissions:\n  contents: read');
    expect(workflow).not.toMatch(/:\s*write\b/);
    expect(workflow).toMatch(/fail-fast: false/);
    const legs = [...workflow.matchAll(/- \{ os: (\S+), bundles: (\S+) \}/g)].map(
      ([, os, bundles]) => `${os} ${bundles}`,
    );
    expect(legs).toEqual(['macos-latest app', 'macos-15-intel app', 'windows-latest nsis', 'ubuntu-22.04 deb']);

    expectPinnedActions(workflow);
    expect(workflow).toMatch(/uses: actions\/checkout@[0-9a-f]{40} # v7\n\s+with:\n\s+persist-credentials: false/);
    expect(workflow).toMatch(/uses: pnpm\/action-setup@[0-9a-f]{40} # v6/);
    expect(workflow).toMatch(
      /uses: actions\/setup-node@[0-9a-f]{40} # v7\n\s+with:\n\s+node-version: 22\.18\.0\n\s+cache: pnpm/,
    );
    // The Rust rust-toolchain.toml pins, here as on the signing Mac: never whatever stable is that day.
    expect(workflow).toContain(
      `rustup toolchain install ${PINNED_RUST} --profile minimal --component rustfmt --component clippy`,
    );
    expect(workflow).not.toMatch(/rustup (?:default|toolchain install) stable/);
    expect(workflow).toContain('libwebkit2gtk-4.1-dev');

    const gates = [
      'pnpm install --frozen-lockfile',
      'pnpm --filter @agentcomms/desktop typecheck',
      'pnpm --filter @agentcomms/desktop test',
      'pnpm --filter @agentcomms/desktop build',
      'pnpm --filter @agentcomms/desktop check:bundle',
      'pnpm --filter @agentcomms/desktop exec playwright install --with-deps chromium',
      'pnpm --filter @agentcomms/desktop test:e2e',
      'cargo fmt --check',
      'cargo clippy --all-targets -- -D warnings',
      'cargo test',
      'pnpm --filter @agentcomms/desktop check:licenses',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow and shell text, not a template
      'pnpm --filter @agentcomms/desktop tauri build --ci --no-sign --bundles ${{ matrix.bundles }}',
    ];
    expect(ascending(positions(workflow, gates))).toBe(true);
    expect(workflow).toMatch(/working-directory: apps\/desktop\/src-tauri/);

    // A pull request's build is unsigned and holds nothing secret: no secret, no signing key, no updater artefacts.
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow).not.toMatch(/TAURI_SIGNING|APPLE_|createUpdaterArtifacts/);
  });

  it('desktop-release.yml checks the tag, verifies, attaches unsigned bundles and never takes Latest', () => {
    const workflow = read(RELEASE_YML);
    const on = block(workflow, 'on');
    expect(on).toBe("on:\n  push:\n    tags: ['desktop-v*']");
    expect(block(workflow, 'permissions')).toBe('permissions: {}');

    const jobs = block(workflow, 'jobs');
    const check = block(jobs, 'check-tag', 2);
    expect(block(check, 'permissions', 4)).toBe('    permissions:\n      contents: read');
    expect(check).toContain(`require('./apps/desktop/src-tauri/tauri.conf.json').version`);
    expect(check).toMatch(/"\$GITHUB_REF_NAME" != "desktop-v\$version"/);

    const verify = block(jobs, 'verify', 2);
    expect(verify).toMatch(/needs: check-tag/);
    expect(verify).toMatch(/uses: \.\/\.github\/workflows\/desktop\.yml/);

    const draft = block(jobs, 'draft', 2);
    expect(draft).toMatch(/needs: \[check-tag, verify\]/);
    expect(block(draft, 'permissions', 4)).toBe('    permissions:\n      contents: write');
    expect(draft).toContain('node apps/desktop/scripts/release-notes.mjs "$version"');
    expect(draft).toContain(
      'gh release create "$GITHUB_REF_NAME" --verify-tag --draft --latest=false --title "Agent Comms $version" --notes-file',
    );

    // A release already published is never filled again: the draft job stops on one.
    const isDraft = '[ "$(gh release view "$GITHUB_REF_NAME" --json isDraft --jq .isDraft)" != true ]';
    expect(draft).toContain(isDraft);

    // The builds hold no token that can write: they run every dependency's code. Their files go on as artifacts.
    const bundle = block(jobs, 'bundle', 2);
    expect(bundle).toMatch(/needs: \[check-tag, verify, draft\]/);
    expect(block(bundle, 'permissions', 4)).toBe('    permissions:\n      contents: read');
    expect(bundle).not.toMatch(/GH_TOKEN|github\.token|gh release|gh api/);
    // A comma ends a value in a flow mapping, so `appimage,deb` is quoted.
    const legs = [...bundle.matchAll(/- \{ os: (\S+), bundles: '?([^'\s]+?)'? \}/g)].map(([, os, b]) => `${os} ${b}`);
    expect(legs).toEqual(['windows-latest nsis', 'ubuntu-22.04 appimage,deb']);
    expect(bundle).toContain('pnpm --filter @agentcomms/desktop tauri build --ci --no-sign --bundles "$BUNDLES"');
    expect(bundle).toContain(
      `rustup toolchain install ${PINNED_RUST} --profile minimal --component rustfmt --component clippy`,
    );
    expect(bundle).toMatch(/uses: actions\/upload-artifact@[0-9a-f]{40} # v7\n\s+with:\n\s+name: desktop-/);

    // Only `attach` writes: it checks nothing out, uploads what the builds made, and only while the release is a draft.
    const attach = block(jobs, 'attach', 2);
    expect(attach).toMatch(/needs: \[check-tag, draft, bundle\]/);
    expect(block(attach, 'permissions', 4)).toBe('    permissions:\n      contents: write');
    expect(attach).not.toMatch(/actions\/checkout|pnpm|node |npm |cargo|tauri/);
    expect(attach).toMatch(/uses: actions\/download-artifact@[0-9a-f]{40} # v7/);
    const upload = attach.indexOf('gh release upload "$GITHUB_REF_NAME" "${assets[@]}" --clobber');
    expect(upload).toBeGreaterThan(attach.indexOf(isDraft));
    expect(attach.indexOf(isDraft)).toBeGreaterThan(-1);
    // Nothing else in the workflow can write.
    const names = [...jobs.matchAll(/^ {2}([\w-]+):$/gm)].map(([, job]) => job ?? '');
    expect(names).toEqual(['check-tag', 'verify', 'draft', 'bundle', 'attach']);
    expect(names.filter((job) => block(jobs, job, 2).includes('contents: write'))).toEqual(['draft', 'attach']);
    expect((workflow.match(/--clobber/g) ?? []).length).toBe(1);

    expectPinnedActions(workflow);
    expectNeverLatest(workflow);
    // CI leaves the release a draft: the owner's publish-desktop.sh, after the signed DMG, makes it public.
    expect(workflow).not.toMatch(/--draft=false/);
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow).not.toMatch(/TAURI_SIGNING|APPLE_|createUpdaterArtifacts/);
  });

  it("leaves the npm release workflow's trigger to v* tags, and its publish job builds the packages alone", () => {
    const release = read('.github/workflows/release.yml');
    expect(block(block(release, 'on'), 'push', 2)).toBe("  push:\n    tags: ['v*']");
    // The job that holds the publish's identity builds no app: `pnpm build` at the root builds apps/desktop too.
    const publish = block(block(release, 'jobs'), 'publish', 2);
    expect(publish).toContain('- run: pnpm -r --filter "./packages/**" run build');
    expect(publish).not.toMatch(/- run: pnpm build\b/);
    expect(JSON.parse(read('package.json')).scripts.build).toContain('--filter "./apps/**"');
    // The verify legs still build everything `pnpm verify` checks, the app's UI with it.
    expect(block(block(release, 'jobs'), 'verify', 2)).toContain('- run: pnpm verify');
    expect(JSON.parse(read('package.json')).scripts.verify).toContain('pnpm build');
  });

  it("desktop.yml runs for every file of the rest of the repository the app's checks read", () => {
    const workflow = read(DESKTOP_YML);
    const patterns = [...block(block(workflow, 'on'), 'pull_request', 2).matchAll(/^\s+- '([^']+)'$/gm)].map(
      ([, glob]) => glob ?? '',
    );
    const covers = (path: string) =>
      patterns.some((glob) =>
        new RegExp(
          `^${glob
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*\*/g, '\u0000')
            .replace(/\*/g, '[^/]*')
            .replace(/\u0000/g, '.*')}$`,
        ).test(path),
      );
    // Every file outside apps/desktop that the app's tests and scripts import or read.
    const sources = ['src/test', 'scripts'].flatMap((folder) =>
      readdirSync(join(APP, folder), { recursive: true })
        .map((entry) => join(APP, folder, String(entry)))
        .filter((path) => /\.(?:ts|tsx|mjs)$/.test(path)),
    );
    const outside = new Set<string>();
    for (const source of sources) {
      for (const [, relative] of readFileSync(source, 'utf8').matchAll(/['"`]((?:\.\.\/){3,4}[\w./-]+)['"`]/g)) {
        const target = join(dirname(source), relative ?? '')
          .slice(ROOT.length + 1)
          .replaceAll('\\', '/');
        if (!target.startsWith('apps/desktop/')) outside.add(target);
      }
    }
    for (const read of [
      'README.md',
      '.gitignore',
      '.github/workflows/release.yml',
      'capabilities.json',
      'packages/core/package.json',
      'test/helpers/printed-command-guard.mjs',
      'scripts/channels.mjs',
    ]) {
      outside.add(read);
    }
    expect(outside.size).toBeGreaterThan(8);
    for (const path of outside) expect(covers(path), `${path} is not in desktop.yml's paths`).toBe(true);
    // And push is filtered the same way.
    expect(block(block(workflow, 'on'), 'push', 2)).toContain(
      block(block(workflow, 'on'), 'pull_request', 2).split('\n').slice(2).join('\n'),
    );
  });

  it('the Rust toolchain is pinned once, and the workflows install that one', () => {
    const pinned = read('apps/desktop/src-tauri/rust-toolchain.toml');
    expect(pinned).toMatch(/^channel = "\d+\.\d+\.\d+"$/m);
    expect(pinned).toMatch(/^components = \["rustfmt", "clippy"\]$/m);
    const manifest = read('apps/desktop/src-tauri/Cargo.toml');
    const floor = /^rust-version = "(\d+)\.(\d+)"$/m.exec(manifest);
    const [major, minor] = PINNED_RUST.split('.').map(Number);
    expect(Number(floor?.[1]) * 1000 + Number(floor?.[2])).toBeLessThanOrEqual((major ?? 0) * 1000 + (minor ?? 0));
    // The signing Mac adds its targets to the pinned toolchain: from the folder that pins it.
    expect(read(RELEASE_SH)).toContain(
      '(cd apps/desktop/src-tauri && rustup target add aarch64-apple-darwin x86_64-apple-darwin)',
    );
  });
});

describe("the owner's release scripts", () => {
  it('release-desktop.sh refuses a dirty tree, a wrong tag, another commit and no terminal, and bakes no token', () => {
    const script = read(RELEASE_SH);
    expect(script.startsWith('#!/bin/bash\nset -euo pipefail\numask 077\n')).toBe(true);
    expect(script).toContain(`VERSION="$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")"`);

    // Every refusal comes before the signing environment is read and before anything is built.
    const refusals = positions(script, [
      '[ "$TAG" = "desktop-v$VERSION" ] || refuse',
      '[ -t 0 ] && [ -t 1 ] || refuse',
      '[ -z "$(git status --porcelain)" ] || refuse',
      'TAG_COMMIT="$(git rev-parse --verify --quiet "$TAG^{commit}")" || refuse',
      '[ "$TAG_COMMIT" = "$(git rev-parse HEAD)" ] || refuse',
      '[ "$TYPED" = "$VERSION" ] || refuse',
    ]);
    const environment = script.indexOf('. "$ENV_FILE"');
    const build = script.indexOf('tauri build');
    expect(environment).toBeGreaterThan(Math.max(...refusals));
    expect(build).toBeGreaterThan(environment);
    expect(script).toMatch(/read -r TYPED/);

    // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow and shell text, not a template
    expect(script).toContain('ENV_FILE="${AGENTCOMMS_DESKTOP_RELEASE_ENV_FILE:-.env.desktop-release.local}"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow and shell text, not a template
    expect(script).toContain('KEY_FILE="${AGENTCOMMS_UPDATER_KEY_FILE:-$HOME/.agentcomms/tauri-updater.key}"');
    // The key's presence, mode and match are updater-key.mjs's, asked before the signing environment is read.
    expect(script).toContain('  TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"\n  export TAURI_SIGNING_PRIVATE_KEY\n');
    expect(script).toContain(
      'pnpm --filter @agentcomms/desktop tauri build --ci --target universal-apple-darwin --bundles app,dmg --config "$UPDATER_CONFIG"',
    );
    expect(script).toContain('OUT="apps/desktop/src-tauri/target/desktop-release/$VERSION"');
    for (const staged of [
      '"$OUT/Agent.Comms.app.tar.gz"',
      '"$OUT/Agent.Comms.app.tar.gz.sig"',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow and shell text, not a template
      '"$OUT/Agent.Comms_${VERSION}_universal.dmg"',
      'SHA256SUMS',
      '"$OUT/.built-at-commit"',
    ]) {
      expect(script).toContain(staged);
    }

    // No token is baked into the app: none is read, and the build runs without one in its environment.
    const code = script
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/RELEASES_TOKEN|(?:export|^)\s*(?:GH_TOKEN|GITHUB_TOKEN)=/m);
    expect(code).toMatch(/env -u GH_TOKEN -u GITHUB_TOKEN /);
    expect(code).not.toMatch(/check:monitor|verify-updater/);
    expectQuietAboutSecrets(script);
  });

  it('release-desktop.sh decides the updater from the key before it reads the signing environment, either way', () => {
    const script = read(RELEASE_SH);
    // The decision is the helper's, and it comes after the refusals and the version typed back, and before the
    // signing environment is read (U8).
    const decided = script.indexOf('UPDATER="$(node apps/desktop/scripts/updater-key.mjs "$KEY_FILE")"');
    expect(decided).toBeGreaterThan(script.indexOf('[ "$TYPED" = "$VERSION" ] || refuse'));
    expect(decided).toBeLessThan(script.indexOf('. "$ENV_FILE"'));
    // On: the key is in the build's environment and the updater artefacts are made, checked and staged.
    expect(script).toContain('if [ "$UPDATER" = on ]; then\n  TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"');
    expect(script).toContain(`UPDATER_CONFIG='{"bundle":{"createUpdaterArtifacts":true}}'`);
    // Off: confirmed by typing it, no key in the build's environment at all, whatever the signing environment held,
    // no updater artefacts, and it says so.
    expect(script).toContain('[ "$OFF" = off ] || refuse');
    expect(script).toContain(`UPDATER_CONFIG='{"bundle":{"createUpdaterArtifacts":false}}'`);
    const unset = script.indexOf('unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
    expect(unset).toBeGreaterThan(script.indexOf('. "$ENV_FILE"'));
    expect(unset).toBeLessThan(script.indexOf('tauri build'));
    expect(script).toContain("echo 'THE UPDATER IS OFF:");
    expect(script).toContain('--config "$UPDATER_CONFIG"');
    expect(script).toContain('printf \'%s\\n\' "$UPDATER" > "$OUT/.updater"');
    // The DMG is notarised with a keychain profile: no password on a command line.
    const notary = script
      .replace(/\\\n\s*/g, ' ')
      .split('\n')
      .filter((line) => /^\s*xcrun notarytool\b/.test(line));
    expect(notary.length).toBeGreaterThan(0);
    for (const line of notary) {
      expect(line).toContain('--keychain-profile "$NOTARY_PROFILE"');
      expect(line).not.toMatch(/--password|--apple-id|APPLE_PASSWORD/);
    }
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell text, not a template
    expect(script).toContain('NOTARY_PROFILE="${AGENTCOMMS_NOTARY_PROFILE:-agentcomms-notary}"');
  });

  it('publish-desktop.sh uploads latest.json only for a release with the updater, and says when it is off', () => {
    const script = read(PUBLISH_SH);
    expect(script).toContain('UPDATER="$(cat "$OUT/.updater")"');
    expect(script).toMatch(/case "\$UPDATER" in on \| off\) ;; \*\) refuse/);
    const manifest = script.indexOf('node apps/desktop/scripts/updater-manifest.mjs');
    const branch = script.lastIndexOf('if [ "$UPDATER" = on ]; then', manifest);
    expect(branch).toBeGreaterThan(-1);
    expect(script.slice(branch, manifest)).not.toMatch(/\nfi\n/);
    expect(script).toMatch(/The updater stays off/);
    // A release already published is never written to again: only a draft is filled.
    expect(script).toContain('gh release view "$TAG" --repo "$REPO" --json isDraft --jq .isDraft');
    expect(script).toMatch(/is already published: bump the version/);
  });

  it('updater-key.mjs: an empty pubkey is off, said loudly; a set one needs its key, mode 600 and matching', () => {
    const folder = mkdtempSync(join(tmpdir(), 'agentcomms-updater-key-'));
    try {
      const config = (pubkey: string) => {
        const path = join(folder, 'tauri.conf.json');
        writeFileSync(path, JSON.stringify({ plugins: { updater: { pubkey, endpoints: [] } } }));
        return path;
      };
      const key = join(folder, 'tauri-updater.key');
      const run = (configFile: string) =>
        spawnSync(process.execPath, [join(APP, 'scripts', 'updater-key.mjs'), key, configFile], { encoding: 'utf8' });

      // No pubkey committed: off, with what to do, and no key needed.
      const off = run(config(''));
      expect(off.status).toBe(0);
      expect(off.stdout).toBe('off\n');
      expect(off.stderr).toMatch(/THE UPDATER IS OFF FOR THIS RELEASE/);
      expect(off.stderr).toMatch(/tauri signer generate -w ~\/\.agentcomms\/tauri-updater\.key/);
      expect(off.stderr).toMatch(/release the next version/);

      // A pubkey committed: the key must be there, its own, and the pubkey's.
      const pub = config('UFVCTElDIEtFWQ==');
      expect(run(pub).status).toBe(1);
      expect(run(pub).stderr).toMatch(/the updater key pair is missing/);
      writeFileSync(key, 'SECRET-KEY-TEXT', { mode: 0o600 });
      writeFileSync(`${key}.pub`, 'ANOTHER KEY\n');
      chmodSync(key, 0o600);
      expect(run(pub).stderr).toMatch(/is not plugins\.updater\.pubkey/);
      writeFileSync(`${key}.pub`, 'UFVCTElDIEtFWQ==\n');
      const on = run(pub);
      expect(on.status).toBe(0);
      expect(on.stdout).toBe('on\n');
      expect(on.stderr).toBe('');
      if (process.platform !== 'win32') {
        chmodSync(key, 0o644);
        const loose = run(pub);
        expect(loose.status).toBe(1);
        expect(loose.stderr).toMatch(/must have mode 600, not 644/);
      }
      // Whatever it says, it never says the key.
      for (const each of [off, on, run(pub)]) expect(`${each.stdout}${each.stderr}`).not.toContain('SECRET-KEY-TEXT');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('publish-desktop.sh writes latest.json for both Mac architectures and never takes Latest', () => {
    const script = read(PUBLISH_SH);
    expect(script.startsWith('#!/bin/bash\nset -euo pipefail\numask 077\n')).toBe(true);
    expect(script).toContain("REPO='crissmoldovan/agent-communications'");
    positions(script, [
      '[ "$TAG" = "desktop-v$VERSION" ] || refuse',
      '[ -t 0 ] && [ -t 1 ] || refuse',
      '[ -z "$(git status --porcelain)" ] || refuse',
      '[ "$BUILT" = "$(git rev-parse HEAD)" ] || refuse',
      '[ "$BUILT" = "$TAG_COMMIT" ] || refuse',
      '[ "$TYPED" = "$VERSION" ] || refuse',
    ]);

    // A release already out is refused; otherwise CI's draft is used, or a draft is made.
    expect(script).toContain('gh release view "$TAG" --repo "$REPO" --json isDraft --jq .isDraft');
    expect(script).toContain(
      'gh release create "$TAG" --repo "$REPO" --verify-tag --draft --latest=false --title "Agent Comms $VERSION" --notes-file',
    );

    const order = positions(script, [
      'gh release upload "$TAG" --repo "$REPO" --clobber "$OUT/$DMG" "$OUT/$ARCHIVE" "$OUT/$ARCHIVE.sig" "$OUT/SHA256SUMS"',
      'node apps/desktop/scripts/updater-manifest.mjs "$REPO" "$TAG" "$OUT/$ARCHIVE.sig" > "$OUT/latest.json"',
      'gh release upload "$TAG" --repo "$REPO" --clobber "$OUT/latest.json"',
      'gh release edit "$TAG" --repo "$REPO" --draft=false --latest=false',
    ]);
    expect(ascending(order)).toBe(true);
    expectNeverLatest(script);
    expectQuietAboutSecrets(script);
  });

  it('the updater manifest names the public archive and its signature for both Mac architectures', async () => {
    const { updaterManifest } = (await import(pathToFileURL(join(APP, 'scripts', 'updater-manifest.mjs')).href)) as {
      updaterManifest: (input: { repo: string; tag: string; signature: string; pubDate?: Date }) => unknown;
    };
    const url =
      'https://github.com/crissmoldovan/agent-communications/releases/download/desktop-v0.24.0/Agent.Comms.app.tar.gz';
    const signed = { signature: 'c2lnbmF0dXJl', url };
    expect(
      updaterManifest({
        repo: 'crissmoldovan/agent-communications',
        tag: 'desktop-v0.24.0',
        signature: 'c2lnbmF0dXJl\n',
        pubDate: new Date('2026-10-19T12:00:00.000Z'),
      }),
    ).toEqual({
      version: '0.24.0',
      notes: 'Agent Comms 0.24.0',
      pub_date: '2026-10-19T12:00:00.000Z',
      platforms: { 'darwin-aarch64': signed, 'darwin-x86_64': signed },
    });
    const repo = 'crissmoldovan/agent-communications';
    expect(() => updaterManifest({ repo, tag: 'v0.24.0', signature: 'x' })).toThrow(/desktop release tag/);
    expect(() => updaterManifest({ repo, tag: 'desktop-v0.24.0-rc.1', signature: 'x' })).toThrow(/desktop release tag/);
    expect(() => updaterManifest({ repo, tag: 'desktop-v0.24.0', signature: ' \n' })).toThrow(/signature is empty/);

    const folder = mkdtempSync(join(tmpdir(), 'agentcomms-manifest-'));
    try {
      writeFileSync(join(folder, 'archive.sig'), 'c2lnbmF0dXJl');
      const run = spawnSync(
        process.execPath,
        [join(APP, 'scripts', 'updater-manifest.mjs'), repo, 'desktop-v0.24.0', join(folder, 'archive.sig')],
        { encoding: 'utf8' },
      );
      expect(run.status).toBe(0);
      const manifest = JSON.parse(run.stdout);
      expect(Object.keys(manifest.platforms)).toEqual(['darwin-aarch64', 'darwin-x86_64']);
      expect(manifest.platforms['darwin-x86_64']).toEqual(signed);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('the release notes say Windows and Linux are unsigned', async () => {
    const script = join(APP, 'scripts', 'release-notes.mjs');
    const { releaseNotes } = (await import(pathToFileURL(script).href)) as { releaseNotes: (v: string) => string };
    const expected = [
      'Agent Comms 0.24.0.',
      'macOS: the DMG is signed with a Developer ID and notarised.',
      'Windows and Linux: the .exe, .AppImage and .deb are unsigned; your system warns before it opens them.',
      'What changed: CHANGELOG.md, 0.24.0.',
    ];
    expect(releaseNotes('0.24.0').split('\n')).toEqual(expected);
    const run = spawnSync(process.execPath, [script, '0.24.0'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${expected.join('\n')}\n`);
    for (const wrong of [[], ['v0.24.0'], ['desktop-v0.24.0'], ['0.24']]) {
      expect(spawnSync(process.execPath, [script, ...wrong], { encoding: 'utf8' }).status).toBe(1);
    }
  });

  it('the signing environment file is one git ignores', () => {
    const ignored = spawnSync('git', ['check-ignore', '--no-index', '-q', '.env.desktop-release.local'], { cwd: ROOT });
    expect(ignored.status).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('both scripts parse (bash -n; Windows has no bash to ask)', () => {
    for (const script of [RELEASE_SH, PUBLISH_SH]) {
      const run = spawnSync('bash', ['-n', join(ROOT, script)], { encoding: 'utf8' });
      expect(run.status, `${script}: ${run.stderr}`).toBe(0);
    }
  });
});

/** No trace, and no line that prints a secret's value. */
function expectQuietAboutSecrets(script: string): void {
  expect(script).not.toMatch(/^\s*set -[a-z]*x/m);
  const secrets =
    /\$\{?(?:TAURI_SIGNING_PRIVATE_KEY|TAURI_SIGNING_PRIVATE_KEY_PASSWORD|APPLE_PASSWORD|APPLE_ID_PASSWORD)\b/;
  const printing = script.split('\n').filter((line) => /\b(?:echo|printf|tee)\b/.test(line) && secrets.test(line));
  expect(printing).toEqual([]);
}

describe('the licence notices', () => {
  type Script = {
    cratesOf: (metadata: unknown) => { name: string; version: string }[];
    rustSection: (crates: object[], textsOf: (crate: { name: string }) => { file: string; text: string }[]) => string;
    resolveStylesheet: (specifier: string, from: string) => string | null;
  };
  const load = async (): Promise<Script> =>
    (await import(pathToFileURL(join(APP, 'scripts', 'third-party-licenses.mjs')).href)) as Script;

  it("follow the app's normal and build dependencies, and leave out what only builds its tests", async () => {
    const { cratesOf } = await load();
    const node = (id: string, deps: [string, (string | null)[]][]) => ({
      id,
      deps: deps.map(([pkg, kinds]) => ({ pkg, dep_kinds: kinds.map((kind) => ({ kind })) })),
    });
    const metadata = {
      packages: ['app', 'serde', 'tauri-build', 'tempfile', 'cc', 'itoa'].map((name) => ({
        id: name,
        name,
        version: '1.0.0',
      })),
      resolve: {
        root: 'app',
        nodes: [
          node('app', [
            ['serde', [null]],
            ['tauri-build', ['build']],
            ['tempfile', ['dev']],
          ]),
          node('serde', [['itoa', [null]]]),
          node('tauri-build', [['cc', ['build']]]),
          node('tempfile', []),
          node('cc', []),
          node('itoa', []),
        ],
      },
    };
    expect(cratesOf(metadata).map((crate) => crate.name)).toEqual(['cc', 'itoa', 'serde', 'tauri-build']);
  });

  it('print a text several crates share once, under each, and name a crate that ships none', async () => {
    const { rustSection } = await load();
    const apache = { file: 'LICENSE-APACHE', text: 'Apache License\nVersion 2.0' };
    const texts: Record<string, { file: string; text: string }[]> = {
      a: [apache, { file: 'LICENSE-MIT', text: 'MIT, a' }],
      b: [apache],
      c: [],
    };
    const crates = ['a', 'b', 'c'].map((name) => ({
      name,
      version: '1.0.0',
      license: 'MIT OR Apache-2.0',
      repository: `https://example.com/${name}`,
    }));
    const section = rustSection(crates, (crate) => texts[crate.name] ?? []);
    expect(section.match(/Apache License/g)).toHaveLength(1);
    expect(section).toMatch(/a@1\.0\.0 — MIT OR Apache-2\.0\nb@1\.0\.0 — MIT OR Apache-2\.0\n-+\nApache License/);
    expect(section).toMatch(
      /Crates that ship no licence file[\s\S]*c@1\.0\.0 — MIT OR Apache-2\.0 {2}https:\/\/example\.com\/c/,
    );
  });

  it("resolve a stylesheet import through the package's style export", async () => {
    const { resolveStylesheet } = await load();
    const target = resolveStylesheet('tailwindcss', join(APP, 'src'));
    expect(target?.replaceAll('\\', '/')).toMatch(/\/tailwindcss\/index\.css$/);
    const ui = resolveStylesheet('@cueplusplus/ui/styles.css', join(APP, 'src'));
    expect(ui?.replaceAll('\\', '/')).toMatch(/\/@cueplusplus\/ui\/dist\/styles\.css$/);
    expect(resolveStylesheet('https://example.com/x.css', join(APP, 'src'))).toBeNull();
  });

  it('are checked in, and checked on every desktop leg', () => {
    const notices = readFileSync(join(APP, 'THIRD_PARTY_LICENSES'), 'utf8');
    for (const key of ['react@19.3.1', '@cueplusplus/ui@0.29.0', '@tauri-apps/api@2.12.4', 'tailwindcss@4.3.3']) {
      expect(notices).toContain(`\n${key} — `);
    }
    expect(notices).toMatch(/\ntauri@2\.\d+\.\d+ — /);
    const manifest = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));
    expect(manifest.scripts['check:licenses']).toBe('node scripts/third-party-licenses.mjs --check');
    expect(manifest.scripts.licenses).toBe('node scripts/third-party-licenses.mjs');
  });
});
