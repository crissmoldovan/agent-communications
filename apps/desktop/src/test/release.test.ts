// @vitest-environment node
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The desktop app's CI, its release workflow and the owner's two release scripts (desktop design DA8, DA15; plan
 * Task 11; 0.26.0 design R1). The scripts sign, notarise and publish from the signing Mac. Here they are read, and run
 * in a temporary repository against stand-ins for everything that would sign, notarise, publish or build, so no test
 * ever does any of that.
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
      "pnpm install --frozen-lockfile --filter '!@agentcomms/events-laya-runtime'",
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
    expect(attach).toMatch(/uses: actions\/download-artifact@[0-9a-f]{40} # v8(?:\.\d+){0,2}\n/);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow and shell text, not a template
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

  /*
   * GitHub's list of releases can lag a few seconds behind a draft just made, and attempt 1 of desktop-v0.24.0's run
   * failed on it. The draft step's own shell runs here against a stand-in `gh`, whose list is empty for the first
   * `lagging` asks, and a stand-in `sleep` that only counts.
   */
  function runDraftLookup(answers: { lagging: number; ids: string }): {
    status: number | null;
    asks: number;
    sleeps: number;
    stderr: string;
  } {
    const step = block(block(block(read(RELEASE_YML), 'jobs'), 'draft', 2), '- name', 6);
    expect(step).toContain('- name: make the draft, unless the release exists');
    const script = step.slice(step.indexOf('run: |') + 'run: |'.length).replace(/^ {10}/gm, '');
    const folder = mkdtempSync(join(tmpdir(), 'agentcomms-draft-lookup-'));
    try {
      const gh = join(folder, 'gh');
      writeFileSync(
        gh,
        [
          '#!/usr/bin/env bash',
          `if [ "$1" = release ]; then case "$*" in *isDraft*) echo true ;; esac; exit 0; fi`,
          `n=$(( $(cat "${folder}/asks" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${folder}/asks"`,
          `[ "$n" -le ${answers.lagging} ] || printf '%s\\n' ${answers.ids
            .split(' ')
            .map((id) => `'${id}'`)
            .join(' ')}`,
          '',
        ].join('\n'),
      );
      const sleep = join(folder, 'sleep');
      writeFileSync(sleep, `#!/usr/bin/env bash\necho x >> "${folder}/sleeps"\n`);
      chmodSync(gh, 0o755);
      chmodSync(sleep, 0o755);
      const run = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${folder}:${process.env.PATH}`,
          GITHUB_REF_NAME: 'desktop-v9.9.9',
          GH_REPO: 'o/r',
          RUNNER_TEMP: folder,
        },
      });
      const count = (file: string): number => {
        try {
          return readFileSync(join(folder, file), 'utf8').trim().split('\n').filter(Boolean).length;
        } catch {
          return 0;
        }
      };
      const asks = Number(readFileSync(join(folder, 'asks'), 'utf8').trim());
      return { status: run.status, asks, sleeps: count('sleeps'), stderr: run.stderr };
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }

  it.skipIf(process.platform === 'win32')(
    "the draft job asks again while GitHub's list lags behind a new draft, for up to 30 s (Windows has no bash to ask)",
    () => {
      const lagged = runDraftLookup({ lagging: 2, ids: '417525829' });
      expect(lagged.status, lagged.stderr).toBe(0);
      expect([lagged.asks, lagged.sleeps]).toEqual([3, 2]);

      // Never there: it gives up after 7 asks and 6 pauses of 5 s, naming what it found.
      const absent = runDraftLookup({ lagging: 99, ids: '1' });
      expect(absent.status).toBe(1);
      expect([absent.asks, absent.sleeps]).toEqual([7, 6]);
      expect(absent.stderr).toContain('expected one release for desktop-v9.9.9, found: ');

      // Two releases for one tag is no lag: it fails at the first answer.
      const two = runDraftLookup({ lagging: 0, ids: '1 2' });
      expect(two.status).toBe(1);
      expect([two.asks, two.sleeps]).toEqual([1, 0]);
      expect(two.stderr).toContain('expected one release for desktop-v9.9.9, found: 1 2');
    },
    // It starts bash about a dozen times, its pauses faked: about 2 s alone, and 15 s on a loaded Mac, past vitest's
    // default 5 s.
    30_000,
  );

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
    // A path filter's glob as GitHub reads it: `**` any folders, `*` any name within one.
    const globRegExp = (glob: string) => {
      const literal = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      const body = glob
        .split('**')
        .map((part) => part.split('*').map(literal).join('[^/]*'))
        .join('.*');
      return new RegExp(`^${body}$`);
    };
    const covers = (path: string) => patterns.some((glob) => globRegExp(glob).test(path));
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
    // The rule text the editor imports from `@agentcomms/events`' source (0.33.0), and every module it imports.
    const ruleText = ['packages/events/src/rule-text/index.ts'];
    const seen = new Set<string>();
    while (ruleText.length > 0) {
      const file = ruleText.pop() ?? '';
      if (seen.has(file)) continue;
      seen.add(file);
      outside.add(file);
      for (const [, specifier] of read(file).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g))
        ruleText.push(join(dirname(file), specifier ?? '').replaceAll('\\', '/'));
    }
    expect(seen.size, 'the rule text and its relative imports').toBeGreaterThan(5);
    for (const read of [
      'README.md',
      '.gitignore',
      '.github/workflows/release.yml',
      'capabilities.json',
      'packages/core/package.json',
      'test/helpers/printed-command-guard.mjs',
      'scripts/channels.mjs',
      'scripts/local-test-release.sh',
    ]) {
      outside.add(read);
    }
    // The Laya Rust mutants step runs E2's cargo leg from the events daemon's tests: every file that entry imports,
    // through every relative import, decides what the step does (E2 review round 1, B10).
    const cargoLeg = /^\s+run: node \S.* (packages\/events-daemon\/\S+\.ts) --leg cargo$/m.exec(workflow)?.[1];
    expect(cargoLeg, 'desktop.yml runs the cargo leg').toBeDefined();
    const pending = [cargoLeg ?? ''];
    const imported = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop() ?? '';
      if (imported.has(file)) continue;
      imported.add(file);
      for (const [, specifier] of read(file).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g))
        pending.push(join(dirname(file), specifier ?? '').replaceAll('\\', '/'));
    }
    expect(imported.size, 'the cargo leg and its relative imports').toBeGreaterThan(4);
    for (const path of imported) outside.add(path);
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
      "--updater off goes with --confirm: at a terminal, type off when asked.'",
      '[ "$TAG" = "desktop-v$VERSION" ] || refuse',
      '[ -t 0 ] && [ -t 1 ] || refuse',
      '[ -z "$(git status --porcelain)" ] || refuse',
      'TAG_COMMIT="$(git rev-parse --verify --quiet "$TAG^{commit}")" || refuse',
      '[ "$TAG_COMMIT" = "$(git rev-parse HEAD)" ] || refuse',
      '[ "$CONFIRM" = "$VERSION" ] || refuse',
      '[ "$TYPED" = "$VERSION" ] || refuse',
      '[ "$UPDATER_FLAG" = off ] || refuse',
      '[ -z "$UPDATER_FLAG" ] || refuse',
    ]);
    const environment = script.indexOf('. "$ENV_FILE"');
    const build = script.indexOf('tauri build');
    expect(environment).toBeGreaterThan(Math.max(...refusals));
    expect(build).toBeGreaterThan(environment);
    expectConfirmOrTerminal(script, 'built');
    expect(script).toContain(
      'apps/desktop/scripts/release-desktop.sh desktop-vX.Y.Z [--confirm X.Y.Z [--updater off]]',
    );
    // The install and every script pnpm runs share CI=true with the build: pnpm 11.22 defaults
    // enableGlobalVirtualStore to false under CI, and verifyDepsBeforeRun refuses a script whose install ran with the
    // other setting (the first real run, 2026-10-21).
    expect(script).toContain("\nCI=true pnpm install --frozen-lockfile --filter '!@agentcomms/events-laya-runtime'\n");
    expect(script).toContain('\nCI=true pnpm --filter @agentcomms/desktop check:bundle\n');
    const pnpmLines = script
      .replace(/\\\n\s*/g, ' ')
      .split('\n')
      .filter((line) => /\bpnpm\b/.test(line) && !line.trimStart().startsWith('#'));
    expect(pnpmLines.length).toBe(3);
    for (const line of pnpmLines) expect(line, line).toMatch(/\bCI=true\s+pnpm\b/);

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
    // With --confirm, --updater off stands for typing off: required when the updater is off, refused when it is on.
    const off = script.indexOf('if [ "$UPDATER" = off ]; then\n  if [ -n "$CONFIRM" ]; then\n');
    expect(off).toBeGreaterThan(decided);
    expect(script.slice(off)).toMatch(
      /^if \[ "\$UPDATER" = off \]; then\n {2}if \[ -n "\$CONFIRM" \]; then\n {4}\[ "\$UPDATER_FLAG" = off \] \|\| refuse 'the updater is off: pass --updater off with --confirm to build it with the updater off\.'\n[\s\S]*?\n {2}else\n[\s\S]*?read -r OFF\n[\s\S]*?\n {2}fi\nelse\n {2}\[ -z "\$UPDATER_FLAG" \] \|\| refuse 'the updater is on: --updater off is refused\.'\nfi\n/,
    );
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

  // The release scripts run only on the owner's signing Mac. On Windows a file's mode reads 666 whatever chmod set, so
  // the mode-600 rule this test walks through cannot be shown there.
  it.skipIf(process.platform === 'win32')(
    'updater-key.mjs: an empty pubkey is off, said loudly; a set one needs its key, mode 600 and matching',
    () => {
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
    },
  );

  it('publish-desktop.sh writes latest.json for both Mac architectures and never takes Latest', () => {
    const script = read(PUBLISH_SH);
    expect(script.startsWith('#!/bin/bash\nset -euo pipefail\numask 077\n')).toBe(true);
    expect(script).toContain("REPO='crissmoldovan/agent-communications'");
    // Every refusal comes before anything is written to the release.
    const refusals = positions(script, [
      '[ "$TAG" = "desktop-v$VERSION" ] || refuse',
      '[ -t 0 ] && [ -t 1 ] || refuse',
      '[ -z "$(git status --porcelain)" ] || refuse',
      '[ "$BUILT" = "$(git rev-parse HEAD)" ] || refuse',
      '[ "$BUILT" = "$TAG_COMMIT" ] || refuse',
      '[ "$CONFIRM" = "$VERSION" ] || refuse',
      '[ "$TYPED" = "$VERSION" ] || refuse',
    ]);
    expect(script.indexOf('gh release')).toBeGreaterThan(Math.max(...refusals));
    expectConfirmOrTerminal(script, 'published');
    expect(script).toContain('apps/desktop/scripts/publish-desktop.sh desktop-vX.Y.Z [--confirm X.Y.Z]');

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

  /*
   * Both scripts run, as an agent runs them once the owner has said so: with pipes for stdio, so with no terminal
   * (0.26.0 design R1). Each runs in a temporary repository, against stand-ins for everything that signs, notarises,
   * publishes or builds; see `releaseHarness`. Windows has no bash to run them.
   */
  describe.skipIf(process.platform === 'win32')('run against stand-ins (Windows has no bash to run them)', () => {
    it('release-desktop.sh builds headless with --confirm against stand-ins, and installs under CI=true', () => {
      const harness = releaseHarness();
      try {
        const run = harness.run(RELEASE_SH, [TAG, '--confirm', '0.26.0', '--updater', 'off'], 'off');
        expect(run.status, told(run)).toBe(0);
        expect(readdirSync(harness.staged).sort()).toEqual([
          '.built-at-commit',
          '.updater',
          'Agent.Comms_0.26.0_universal.dmg',
          'SHA256SUMS',
        ]);
        expect(readFileSync(join(harness.staged, '.updater'), 'utf8')).toBe('off\n');
        expect(readFileSync(join(harness.staged, '.built-at-commit'), 'utf8')).toBe(`${harness.commit}\n`);
        expect(readFileSync(join(harness.staged, 'SHA256SUMS'), 'utf8')).toMatch(
          /^[0-9a-f]{64} {2}Agent\.Comms_0\.26\.0_universal\.dmg\n$/,
        );

        // The install runs under CI=true, as the build and the bundle check do: pnpm refuses a script whose install
        // ran with the other setting, which the stand-in does as pnpm 11.22 does.
        const pnpm = run.calls.filter((call) => call.startsWith('pnpm '));
        expect(pnpm).toEqual([
          'pnpm install --frozen-lockfile --filter !@agentcomms/events-laya-runtime CI=true',
          'pnpm --filter @agentcomms/desktop tauri build --ci --target universal-apple-darwin --bundles app,dmg --config {"bundle":{"createUpdaterArtifacts":false}} CI=true',
          'pnpm --filter @agentcomms/desktop check:bundle CI=true',
        ]);

        // No call reached anything but a stand-in: the PATH holds only the stand-ins and the harmless tools, and
        // each step that would sign, notarise or check a signature went to its stand-in.
        expect(readdirSync(harness.bin).sort()).toEqual([...Object.keys(STAND_INS), ...HARMLESS, 'node'].sort());
        for (const step of [
          'uname -s',
          'security find-identity -v -p codesigning',
          'xcrun notarytool history --keychain-profile agentcomms-notary',
          'rustup target add aarch64-apple-darwin x86_64-apple-darwin',
          'lipo -archs',
          'codesign --verify --deep --strict --verbose=2',
          'spctl --assess --type execute',
          'xcrun stapler validate',
          'xcrun notarytool submit',
          'xcrun stapler staple',
        ]) {
          expect(
            run.calls.some((call) => call.startsWith(`${step} `)),
            step,
          ).toBe(true);
        }
        expect(`${run.stdout}${run.stderr}`).not.toMatch(/fake-app-password|STAND-IN-UPDATER-KEY/);
      } finally {
        harness.remove();
      }
    }, 60_000);

    it('with the updater on, --confirm alone builds and stages the updater archive', () => {
      const harness = releaseHarness();
      try {
        const run = harness.run(RELEASE_SH, [TAG, '--confirm', '0.26.0'], 'on');
        expect(run.status, told(run)).toBe(0);
        expect(readdirSync(harness.staged).sort()).toEqual([
          '.built-at-commit',
          '.updater',
          'Agent.Comms.app.tar.gz',
          'Agent.Comms.app.tar.gz.sig',
          'Agent.Comms_0.26.0_universal.dmg',
          'SHA256SUMS',
        ]);
        expect(readFileSync(join(harness.staged, '.updater'), 'utf8')).toBe('on\n');
        expect(readFileSync(join(harness.staged, 'SHA256SUMS'), 'utf8')).toMatch(
          /^[0-9a-f]{64} {2}Agent\.Comms\.app\.tar\.gz\n[0-9a-f]{64} {2}Agent\.Comms_0\.26\.0_universal\.dmg\n$/,
        );
        expect(run.calls).toContain(
          'pnpm --filter @agentcomms/desktop tauri build --ci --target universal-apple-darwin --bundles app,dmg --config {"bundle":{"createUpdaterArtifacts":true}} CI=true',
        );
        // The archive was opened in a temporary folder, and the app inside it checked.
        expect(
          run.calls.filter((call) => /^codesign --verify --deep --strict \/\S.*\/Agent Comms\.app CI=$/.test(call)),
        ).toHaveLength(1);
        expect(`${run.stdout}${run.stderr}`).not.toMatch(/fake-app-password|STAND-IN-UPDATER-KEY/);
      } finally {
        harness.remove();
      }
    }, 60_000);

    it('a wrong --confirm, a missing --updater off, or --updater off with the updater on is refused before anything is built', () => {
      const harness = releaseHarness();
      try {
        const cases: [Updater, string[], string][] = [
          ['on', ['--confirm', '0.26.1'], 'the version given to --confirm does not match; nothing was built.'],
          [
            'off',
            ['--confirm', '0.25.0', '--updater', 'off'],
            'the version given to --confirm does not match; nothing was built.',
          ],
          [
            'off',
            ['--confirm', '0.26.0'],
            'the updater is off: pass --updater off with --confirm to build it with the updater off.',
          ],
          ['on', ['--confirm', '0.26.0', '--updater', 'off'], 'the updater is on: --updater off is refused.'],
        ];
        for (const [updater, args, sentence] of cases) {
          const run = harness.run(RELEASE_SH, [TAG, ...args], updater);
          expect(run.status, args.join(' ')).toBe(1);
          expect(run.stderr).toBe(`release-desktop: ${sentence}\n`);
          // Refused before the signing environment, the identity, the install or the build.
          expect(run.calls.filter((call) => !/^(?:git|uname) /.test(call))).toEqual([]);
          expect(existsSync(harness.staged)).toBe(false);
        }
      } finally {
        harness.remove();
      }
    }, 60_000);

    it('without --confirm, the scripts still need a terminal', () => {
      const harness = releaseHarness();
      try {
        for (const [script, name] of [
          [RELEASE_SH, 'release-desktop'],
          [PUBLISH_SH, 'publish-desktop'],
        ] as const) {
          const run = harness.run(script, [TAG], 'on');
          expect(run.status).toBe(1);
          expect(run.stderr).toBe(`${name}: run this in a terminal: it asks for the version to be typed back.\n`);
          expect(run.calls.filter((call) => !/^(?:git|uname) /.test(call))).toEqual([]);
        }
      } finally {
        harness.remove();
      }
    }, 60_000);

    it('--updater off without --confirm is refused', () => {
      const harness = releaseHarness();
      try {
        const run = harness.run(RELEASE_SH, [TAG, '--updater', 'off'], 'off');
        expect(run.status).toBe(1);
        expect(run.stderr).toBe(
          'release-desktop: --updater off goes with --confirm: at a terminal, type off when asked.\n',
        );
        expect(run.calls).toEqual([]);
      } finally {
        harness.remove();
      }
    }, 60_000);

    it('an unknown argument, or --confirm with no version, is refused by both scripts', () => {
      const harness = releaseHarness();
      try {
        const cases: [string, string[], string][] = [
          [RELEASE_SH, ['--yes'], 'release-desktop: unknown argument: --yes'],
          [RELEASE_SH, ['--confirm'], 'release-desktop: --confirm takes the version: usage: '],
          [
            RELEASE_SH,
            ['--confirm', '0.26.0', '--updater', 'on'],
            'release-desktop: --updater takes only off: usage: ',
          ],
          [PUBLISH_SH, ['--confirm', '0.26.0', '--updater', 'off'], 'publish-desktop: unknown argument: --updater'],
          [PUBLISH_SH, ['--confirm'], 'publish-desktop: --confirm takes the version: usage: '],
        ];
        for (const [script, args, refusal] of cases) {
          const run = harness.run(script, [TAG, ...args], 'on');
          expect(run.status, args.join(' ')).toBe(1);
          expect(run.stderr.startsWith(refusal), run.stderr).toBe(true);
          expect(run.calls).toEqual([]);
        }
      } finally {
        harness.remove();
      }
    }, 60_000);

    it('publish-desktop.sh publishes headless with --confirm against a stand-in gh, and a wrong one is refused', () => {
      const harness = releaseHarness();
      try {
        const release = harness.run(RELEASE_SH, [TAG, '--confirm', '0.26.0'], 'on');
        expect(release.status, told(release)).toBe(0);

        const wrong = harness.run(PUBLISH_SH, [TAG, '--confirm', '0.25.0']);
        expect(wrong.status).toBe(1);
        expect(wrong.stderr).toBe(
          'publish-desktop: the version given to --confirm does not match; nothing was published.\n',
        );
        expect(wrong.calls.filter((call) => call.startsWith('gh release'))).toEqual([]);
        expect(readFileSync(join(harness.state, 'draft'), 'utf8')).toBe('true\n');

        const run = harness.run(PUBLISH_SH, [TAG, '--confirm', '0.26.0']);
        expect(run.status, told(run)).toBe(0);
        const out = 'apps/desktop/src-tauri/target/desktop-release/0.26.0';
        const order = positions(run.calls.join('\n'), [
          `gh release view ${TAG} --repo ${REPO} --json isDraft --jq .isDraft CI=`,
          `gh release upload ${TAG} --repo ${REPO} --clobber ${out}/Agent.Comms_0.26.0_universal.dmg ${out}/Agent.Comms.app.tar.gz ${out}/Agent.Comms.app.tar.gz.sig ${out}/SHA256SUMS apps/desktop/THIRD_PARTY_LICENSES CI=`,
          `gh release upload ${TAG} --repo ${REPO} --clobber ${out}/latest.json CI=`,
          `gh release edit ${TAG} --repo ${REPO} --draft=false --latest=false CI=`,
        ]);
        expect(ascending(order)).toBe(true);
        expect(readFileSync(join(harness.state, 'draft'), 'utf8')).toBe('false\n');
        expect(readFileSync(join(harness.repo, out, 'latest.json'), 'utf8')).toBe('{"version":"0.26.0"}\n');
      } finally {
        harness.remove();
      }
    }, 60_000);
  });
});

/**
 * Without `--confirm`, a terminal and the version typed back, as before. With it, neither, and the version given must
 * be the app's, as typing it back must (0.26.0 design R1).
 */
function expectConfirmOrTerminal(script: string, nothing: 'built' | 'published'): void {
  expect(script.match(/\[ -t 0 \]/g) ?? []).toHaveLength(1);
  expect(script).toContain(
    `if [ -z "$CONFIRM" ]; then\n  [ -t 0 ] && [ -t 1 ] || refuse 'run this in a terminal: it asks for the version to be typed back.'\nfi\n`,
  );
  expect(script.match(/\bread -r TYPED\b/g) ?? []).toHaveLength(1);
  const start = script.indexOf('\nif [ -n "$CONFIRM" ]; then\n');
  const otherwise = script.indexOf('\nelse\n', start);
  const end = script.indexOf('\nfi\n', otherwise);
  expect(start).toBeGreaterThan(-1);
  expect(otherwise).toBeGreaterThan(start);
  expect(end).toBeGreaterThan(otherwise);
  const confirmed = script.slice(start, otherwise);
  const asked = script.slice(otherwise, end);
  expect(confirmed).toContain(
    `\n  [ "$CONFIRM" = "$VERSION" ] || refuse 'the version given to --confirm does not match; nothing was ${nothing}.'`,
  );
  expect(confirmed).not.toMatch(/\bread\b/);
  expect(asked).toContain('\n  read -r TYPED\n');
  expect(asked).toContain(
    `\n  [ "$TYPED" = "$VERSION" ] || refuse 'the version typed back does not match; nothing was ${nothing}.'`,
  );
}

type Updater = 'on' | 'off';

const TAG = 'desktop-v0.26.0';
const REPO = 'crissmoldovan/agent-communications';
const IDENTITY = 'Developer ID Application: Stand-in Signer (TEAM000000)';

/** The real tools the scripts and the stand-ins use, none of which signs, notarises, publishes or builds anything. */
const HARMLESS = [
  'awk',
  'basename',
  'bash',
  'cat',
  'cp',
  'dirname',
  'env',
  'grep',
  'gzip',
  'mkdir',
  'mktemp',
  'rm',
  'shasum',
  'tar',
];

/**
 * What each stand-in does once it has written `<name> <args> CI=$CI` to the log; `@STATE@` is its folder, `@GIT@` the
 * real git. Anything a stand-in is not written to answer fails, so a script that asks something new fails here too.
 */
const STAND_INS: Record<string, string> = {
  uname: 'echo Darwin',
  security: [
    `[ "$*" = 'find-identity -v -p codesigning' ] || exit 1`,
    `printf '  1) %s "%s"\\n     1 valid identities found\\n' 0000000000000000000000000000000000000000 '${IDENTITY}'`,
  ].join('\n'),
  rustup: `[ "$1 $2" = 'target add' ]`,
  // Each checks the path it is given, the last argument, which the build made.
  codesign: `[ "$1" = --verify ] && [ -e "\${!#}" ]`,
  spctl: `[ "$1" = --assess ] && [ -e "\${!#}" ]`,
  lipo: `[ "$1" = -archs ] && [ -e "$2" ] && echo 'x86_64 arm64'`,
  xcrun: [
    'case "$1 $2" in',
    `  'notarytool history') ;;`,
    `  'notarytool submit') [ -e "$3" ] && echo '{"status":"Accepted"}' ;;`,
    `  'stapler validate' | 'stapler staple') [ -e "$3" ] ;;`,
    `  *) echo "xcrun stand-in: not expected: $*" >&2; exit 1 ;;`,
    'esac',
  ].join('\n'),
  // pnpm 11.22 checks the install before it runs a script (verifyDepsBeforeRun), and refuses one whose install ran
  // with the other CI setting: under CI, enableGlobalVirtualStore defaults to false.
  pnpm: [
    `mode=on; case "$CI" in '' | false) mode=off ;; esac`,
    `if [ "$1" = install ]; then echo "$mode" > '@STATE@/installed'; exit 0; fi`,
    `if [ "$(cat '@STATE@/installed' 2>/dev/null)" != "$mode" ]; then`,
    `  echo '[ERR_PNPM_VERIFY_DEPS_BEFORE_RUN] The value of the enableGlobalVirtualStore setting has changed' >&2`,
    '  exit 1',
    'fi',
    'bundle=apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle',
    'case "$*" in',
    `  '--filter @agentcomms/desktop tauri build --ci --target universal-apple-darwin --bundles app,dmg --config '*)`,
    `    mkdir -p "$bundle/macos/Agent Comms.app/Contents/MacOS" "$bundle/dmg"`,
    `    echo stand-in > "$bundle/macos/Agent Comms.app/Contents/MacOS/agentcomms-desktop"`,
    `    echo stand-in > "$bundle/dmg/Agent Comms_0.26.0_universal.dmg"`,
    `    case "$*" in *'"createUpdaterArtifacts":true'*)`,
    `      tar -czf "$bundle/macos/Agent Comms.app.tar.gz" -C "$bundle/macos" 'Agent Comms.app'`,
    `      echo stand-in-signature > "$bundle/macos/Agent Comms.app.tar.gz.sig" ;;`,
    '    esac ;;',
    `  '--filter @agentcomms/desktop check:bundle') ;;`,
    `  *) echo "pnpm stand-in: not expected: $*" >&2; exit 1 ;;`,
    'esac',
  ].join('\n'),
  // A draft the Desktop release workflow made, with its Windows and Linux files attached.
  gh: [
    'case "$*" in',
    `  "repo view ${REPO} --json isPrivate --jq .isPrivate") echo false ;;`,
    `  "api repos/${REPO}/commits/"*" --silent") ;;`,
    `  "api --paginate repos/${REPO}/releases?per_page=100 --jq "*) echo 417525829 ;;`,
    `  "release view ${TAG} --repo ${REPO}") ;;`,
    `  "release view ${TAG} --repo ${REPO} --json isDraft --jq .isDraft") cat '@STATE@/draft' ;;`,
    `  "release view ${TAG} --repo ${REPO} --json assets --jq .assets[].name") cat '@STATE@/assets' ;;`,
    `  "release view ${TAG} --repo ${REPO} --json url,isDraft,isPrerelease,assets --jq "*) echo '{"isDraft":false}' ;;`,
    `  "release upload ${TAG} --repo ${REPO} --clobber "*)`,
    '    shift 6',
    `    for file in "$@"; do [ -e "$file" ] || exit 1; printf '%s\\n' "$(basename "$file")" >> '@STATE@/assets'; done ;;`,
    `  "release edit ${TAG} --repo ${REPO} --draft=false --latest=false") echo false > '@STATE@/draft' ;;`,
    `  *) echo "gh stand-in: not expected: $*" >&2; exit 1 ;;`,
    'esac',
  ].join('\n'),
  // The real git, except ls-remote, which answers for GitHub with the tag's commit.
  git: [
    'if [ "$1" = ls-remote ]; then',
    `  printf '%s\\t%s\\n' "$('@GIT@' rev-parse '${TAG}^{commit}')" 'refs/tags/${TAG}'`,
    '  exit 0',
    'fi',
    `exec '@GIT@' "$@"`,
  ].join('\n'),
};

/** What a run said, and what it asked the stand-ins, for a failing assertion's message. */
function told(run: { stderr: string; calls: string[] }): string {
  return `${run.stderr}\nwhat the stand-ins were asked:\n${run.calls.join('\n')}`;
}

/** The first executable called `name` on this process's PATH. */
function onPath(name: string): string {
  for (const folder of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(folder, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  throw new Error(`${name} is not on the PATH`);
}

/**
 * A temporary repository with the two real scripts at `apps/desktop/scripts/`, stand-ins for the helpers they call,
 * `tauri.conf.json` at 0.26.0, committed and tagged `desktop-v0.26.0`. The scripts run there with a PATH that holds
 * only the stand-ins and the harmless tools, so nothing they call can sign, notarise, publish or build; the signing
 * environment is made up, and none of it is this machine's.
 */
function releaseHarness() {
  const folder = mkdtempSync(join(tmpdir(), 'agentcomms-release-scripts-'));
  const repo = join(folder, 'repo');
  const bin = join(folder, 'bin');
  const state = join(folder, 'state');
  const home = join(folder, 'home');
  const temp = join(folder, 'tmp');
  for (const path of [repo, bin, state, home, temp]) mkdirSync(path);
  const log = join(folder, 'calls.log');
  const realGit = onPath('git');
  const gitEnvironment = { HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

  const files: Record<string, string> = {
    '.gitignore': 'apps/desktop/src-tauri/target/\n',
    'apps/desktop/src-tauri/tauri.conf.json': `${JSON.stringify({ version: '0.26.0', plugins: { updater: { pubkey: '' } } })}\n`,
    'apps/desktop/THIRD_PARTY_LICENSES': 'stand-in notices\n',
    'apps/desktop/scripts/updater-key.mjs': 'console.log(process.env.TEST_UPDATER);\n',
    'apps/desktop/scripts/third-party-licenses.mjs': '',
    'apps/desktop/scripts/release-notes.mjs': "console.log('Agent Comms ' + process.argv[2] + '.');\n",
    'apps/desktop/scripts/updater-manifest.mjs': "console.log(JSON.stringify({ version: '0.26.0' }));\n",
    [RELEASE_SH]: read(RELEASE_SH),
    [PUBLISH_SH]: read(PUBLISH_SH),
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text, { mode: path.endsWith('.sh') ? 0o755 : 0o644 });
  }
  const git = (...args: string[]) => {
    const run = spawnSync(realGit, ['-c', 'user.name=Stand-in', '-c', 'user.email=stand-in@example.invalid', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...gitEnvironment, PATH: process.env.PATH ?? '' },
    });
    expect(run.status, `git ${args.join(' ')}: ${run.stderr}`).toBe(0);
    return run.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Agent Comms 0.26.0');
  git('-c', 'tag.gpgsign=false', 'tag', TAG);
  const commit = git('rev-parse', 'HEAD');

  for (const [name, body] of Object.entries(STAND_INS)) {
    const script = body.replaceAll('@STATE@', state).replaceAll('@GIT@', realGit);
    writeFileSync(join(bin, name), `#!/bin/bash\nprintf '%s\\n' "${name} $* CI=$CI" >> '${log}'\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  // Each by its full path, not a link: macOS's shasum is a perl script that will not run under another path.
  const tools: [string, string][] = [
    ...HARMLESS.map((tool): [string, string] => [tool, onPath(tool)]),
    ['node', process.execPath],
  ];
  for (const [tool, path] of tools) {
    writeFileSync(join(bin, tool), `#!/bin/bash\nexec '${path}' "$@"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  writeFileSync(join(state, 'draft'), 'true\n');
  writeFileSync(
    join(state, 'assets'),
    ['Agent.Comms_0.26.0_x64-setup.exe', 'Agent.Comms_0.26.0_amd64.AppImage', 'Agent.Comms_0.26.0_amd64.deb', ''].join(
      '\n',
    ),
  );
  const keyFile = join(folder, 'tauri-updater.key');
  writeFileSync(keyFile, 'STAND-IN-UPDATER-KEY\n', { mode: 0o600 });

  return {
    repo,
    bin,
    state,
    commit,
    staged: join(repo, 'apps/desktop/src-tauri/target/desktop-release/0.26.0'),
    /** Runs `script` with stdio as pipes, so with no terminal, and returns what the stand-ins were asked. */
    run(script: string, args: string[], updater: Updater = 'on') {
      writeFileSync(log, '');
      const run = spawnSync(join(bin, 'bash'), [join(repo, script), ...args], {
        cwd: folder,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 50_000,
        // Only these, so nothing of this machine's own signing environment, CI or tokens reaches the scripts.
        env: {
          ...gitEnvironment,
          PATH: bin,
          TMPDIR: temp,
          APPLE_SIGNING_IDENTITY: IDENTITY,
          APPLE_ID: 'stand-in-apple-id',
          APPLE_TEAM_ID: 'TEAM000000',
          APPLE_PASSWORD: 'fake-app-password',
          AGENTCOMMS_UPDATER_KEY_FILE: keyFile,
          TEST_UPDATER: updater,
        },
      });
      const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
      return { status: run.status, stdout: run.stdout, stderr: run.stderr, calls };
    },
    remove: () => rmSync(folder, { recursive: true, force: true }),
  };
}

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
    firstPartySource: (file: string, root?: string, app?: string) => boolean;
    cratesOf: (metadata: unknown) => { name: string; version: string }[];
    rustSection: (crates: object[], textsOf: (crate: { name: string }) => { file: string; text: string }[]) => string;
    resolveStylesheet: (specifier: string, from: string) => string | null;
  };
  const load = async (): Promise<Script> =>
    (await import(pathToFileURL(join(APP, 'scripts', 'third-party-licenses.mjs')).href)) as Script;

  it("take the repository's own package source as the app's, and nothing else of a package (0.33.0)", async () => {
    const { firstPartySource } = await load();
    // The rule text the editor imports from `@agentcomms/events`: the repository's own, under the app's licence.
    expect(firstPartySource(join(ROOT, 'packages', 'events', 'src', 'rule-text', 'parse.ts'))).toBe(true);
    // A package's vendored data is its vendor's, and outside `src` is not the source the app imports.
    expect(firstPartySource(join(ROOT, 'packages', 'events', 'vendor', 'unicode-15.1.0', 'generated', 'x.ts'))).toBe(
      false,
    );
    expect(firstPartySource(join(ROOT, 'packages', 'events', 'dist', 'index.mjs'))).toBe(false);
    expect(firstPartySource(join(ROOT, 'packages', 'no-such-package', 'src', 'index.ts'))).toBe(false);
    expect(firstPartySource(join(ROOT, 'node_modules', 'zod', 'index.js'))).toBe(false);
  });

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
    for (const key of ['react@19.3.1', '@cueplusplus/ui@0.34.0', '@tauri-apps/api@2.12.4', 'tailwindcss@4.3.3']) {
      expect(notices).toContain(`\n${key} — `);
    }
    expect(notices).toMatch(/\ntauri@2\.\d+\.\d+ — /);
    const manifest = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));
    expect(manifest.scripts['check:licenses']).toBe('node scripts/third-party-licenses.mjs --check');
    expect(manifest.scripts.licenses).toBe('node scripts/third-party-licenses.mjs');
  });
});
