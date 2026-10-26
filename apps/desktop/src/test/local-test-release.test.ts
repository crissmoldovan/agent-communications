// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP = fileURLToPath(new URL('../../', import.meta.url));
const ROOT = join(APP, '..', '..');
/** The owner's local test release (`scripts/local-test-release.sh`): read here, and never run. */
const SCRIPT = readFileSync(join(ROOT, 'scripts', 'local-test-release.sh'), 'utf8');

/** The script's `build_stamp` function, as it is written there. */
const STAMP = /^build_stamp\(\) \{\n[\s\S]*?\n\}$/m.exec(SCRIPT)?.[0] ?? '';

/** Runs `git` in `cwd`, as nobody in particular, and gives back what it printed. */
function git(cwd: string, ...args: string[]): string {
  const run = spawnSync(
    'git',
    [
      '-c',
      'user.name=Example',
      '-c',
      'user.email=example@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

/** Runs the script's `build_stamp` alone, in `cwd`, for `commit` and `ref`, and gives back the two words it exports. */
function stamp(cwd: string, commit: string, ref: string): { commit: string; time: string } {
  const file = join(cwd, 'stamp.sh');
  writeFileSync(
    file,
    `set -eu\n${STAMP}\nbuild_stamp "$1" "$2"\nprintf '%s\\n%s\\n' "$AGENTCOMMS_BUILD_COMMIT" "$AGENTCOMMS_BUILD_TIME"\n`,
  );
  const run = spawnSync('sh', [file, commit, ref], { cwd, encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  const [committed = '', time = ''] = run.stdout.split('\n');
  return { commit: committed, time };
}

describe('the local test release stamps the build it makes (spec §3.7)', () => {
  it('exports the commit and the build time before it builds the app, which compiles them in', () => {
    expect(STAMP).not.toBe('');
    expect(STAMP).toContain('export AGENTCOMMS_BUILD_COMMIT AGENTCOMMS_BUILD_TIME');
    const lines = SCRIPT.split('\n');
    const stamped = lines.findIndex((line) => line.trim() === 'build_stamp "$commit" "$ref"');
    const built = lines.findIndex((line) => line.includes('tauri build'));
    expect(stamped).toBeGreaterThan(-1);
    expect(built).toBeGreaterThan(stamped);
    // The test app is sealed with an ad-hoc signature once it is in place, so core can attest the approvals it makes
    // (`desktopAppOrigin`): an unsealed bundle does not pass codesign --verify --strict.
    const copied = lines.findIndex((line) => line.startsWith('cp -R "$built" "$app_dest"'));
    const sealed = lines.findIndex((line) => line.startsWith('codesign --force --deep --sign - "$app_dest"'));
    expect(copied).toBeGreaterThan(built);
    expect(sealed).toBeGreaterThan(copied);
    // The test profile is marked, in its config folder and nowhere else: core lets the test app approve only for a
    // folder that holds the mark (`desktopAppOrigin`).
    const marks = lines.filter((line) => line.includes('.agentcomms-test-profile') && !line.trim().startsWith('#'));
    expect(marks).toEqual([': > "$profile/config/.agentcomms-test-profile"']);
    // The names the app reads (`build_info.rs`).
    const rust = readFileSync(join(APP, 'src-tauri', 'src', 'build_info.rs'), 'utf8');
    expect(rust).toContain('option_env!("AGENTCOMMS_BUILD_COMMIT")');
    expect(rust).toContain('option_env!("AGENTCOMMS_BUILD_TIME")');
  });

  it.skipIf(process.platform === 'win32')(
    'the commit is the short commit and the branch pointing at it, and the time is UTC (Windows has no sh to ask)',
    () => {
      const repo = mkdtempSync(join(tmpdir(), 'agentcomms-stamp-'));
      try {
        git(repo, 'init', '-q', '-b', 'feat/0.32');
        git(repo, 'commit', '-q', '--allow-empty', '-m', 'one');
        const one = git(repo, 'rev-parse', 'HEAD');
        const short = git(repo, 'rev-parse', '--short', one);
        // HEAD on a branch: that branch.
        const first = stamp(repo, one, 'HEAD');
        expect(first.commit).toBe(`${short} feat/0.32`);
        expect(first.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        // A branch named as the ref: that one, though another points at the same commit.
        git(repo, 'branch', 'another');
        expect(stamp(repo, one, 'another').commit).toBe(`${short} another`);
        // A commit no branch points at: the short commit alone.
        git(repo, 'checkout', '-q', '--detach');
        git(repo, 'commit', '-q', '--allow-empty', '-m', 'two');
        const two = git(repo, 'rev-parse', 'HEAD');
        expect(stamp(repo, two, 'HEAD').commit).toBe(git(repo, 'rev-parse', '--short', two));
        // Detached at a commit a branch points at: that branch.
        git(repo, 'checkout', '-q', '--detach', one);
        expect(stamp(repo, one, one).commit).toMatch(new RegExp(`^${short} (another|feat/0\\.32)$`));
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );
});
