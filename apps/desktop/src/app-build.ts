/**
 * The test build, told apart (0.32.0, spec 2026-10-26-owner-feedback-0320 §3.7): which build the app is, from Rust's
 * `app_build`, and the words the window marks a test build with. A release build shows none of them.
 */
import { useEffect, useState } from 'react';
import { useBridge } from './bridge-context.tsx';
import type { AppBuild, Folders } from './ipc.ts';
import { shownFolder } from './lanes.ts';

/** The words the window marks a test build with (the prototype's, row 5, screen 2). */
export const TEST_BUILD_COPY = {
  /** The band's name, for a screen reader. */
  band: 'Test build',
  heading: 'TEST BUILD',
  profileLine: 'Uses the test profile, not your real accounts',
  appName: 'Agent Comms Test',
  chip: 'T',
  /** What the sidebar's foot names. */
  profile: 'Test profile',
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** `app_build`'s answer, read: null when it is not that answer at all. */
export function readAppBuild(value: unknown): AppBuild | null {
  if (!isRecord(value) || typeof value.identifier !== 'string' || typeof value.isTest !== 'boolean') return null;
  return {
    identifier: value.identifier,
    isTest: value.isTest,
    commit: text(value.commit),
    builtAt: text(value.builtAt),
  };
}

/**
 * Which build this is, once Rust has said: null until then, and when it could not say (an older shell, a browser
 * preview), which the window shows as a release.
 */
export function useAppBuild(): AppBuild | null {
  const bridge = useBridge();
  const [build, setBuild] = useState<AppBuild | null>(null);
  useEffect(() => {
    let live = true;
    bridge
      .appBuild()
      .then((value) => {
        if (live) setBuild(readAppBuild(value));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [bridge]);
  return build;
}

/**
 * The compiled-in commit, as `local-test-release.sh` writes it: the short commit, then the branch pointing at it, if
 * one does (a branch's name holds no space).
 */
export function splitCommit(value: string | null): { commit: string | null; branch: string | null } {
  const [commit, ...rest] = (value ?? '').trim().split(/\s+/);
  return { commit: commit === undefined || commit === '' ? null : commit, branch: rest.join(' ') || null };
}

/** When the build was made, said short in the person's own locale: "Oct 26, 14:05". */
export function builtTime(at: string): string {
  return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The folders a path is made of, and the separator it uses. */
function parts(path: string): { separator: string; names: string[] } {
  const separator = path.includes('\\') && !path.includes('/') ? '\\' : '/';
  return { separator, names: path.split(separator) };
}

/**
 * The test profile's folder, with the home as `~`: the folder the config, state and data folders share, as the test
 * release lays them out (`<profile>/config`, `/state`, `/data`). Folders that share only the home, or nothing, name the
 * config folder instead.
 */
export function profileFolder(folders: Folders, home: string | null | undefined): string {
  const { separator, names } = parts(folders.configDir);
  const others = [folders.stateDir, folders.dataDir].map((path) => parts(path).names);
  let shared = 0;
  while (shared < names.length && others.every((other) => other[shared] === names[shared])) shared += 1;
  const common = names.slice(0, shared).join(separator);
  const homeBase = home?.replace(/[\\/]+$/, '') ?? null;
  const tooWide = shared <= 1 || common === '' || /^[A-Za-z]:$/.test(common) || common === homeBase;
  return shownFolder(tooWide ? folders.configDir : common, home);
}
