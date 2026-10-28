import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { compareUtf8 } from '@agentcomms/events';
import {
  foldGitHubRepo,
  type ProjectScanResultV1,
  type ProjectScanSkippedV1,
  type ProjectScanSkipReason,
} from '../domain/projects.ts';
import { isInside } from './agent-sessions.ts';
import { type GitRunner, repoConfigRefusal } from './git.ts';

/**
 * `project scan` (workflows design §8.1): the GitHub repositories checked out on this Mac, found by walking the roots
 * to `maxDepth` folders down. It follows no symlink, passes over hidden folders (but `.claude/worktrees`, where Claude
 * Code keeps its worktrees) and Agent Comms' own folders, and stops at a checkout: what is inside one is the person's
 * work, not something to list. It never reads a file's contents. It looks at whether `.git` is a folder (a checkout) or
 * a file (a worktree), and runs only `git config --get remote.origin.url`, `git worktree list --porcelain` and the
 * gate's `git config --list --show-scope -z`, through the git runner (no shell, no `GIT_*`, no hooks). Checkouts are
 * grouped by the repository their origin names, in https or ssh form alike; a remote that is not GitHub's is passed
 * over. A folder whose repository's own config names a program git would run is passed over too (`unsafe-config`, with
 * the key and its scope; 0.37.0 design §3), so the person sees why before choosing it.
 */

/** Folders looked at in one scan, at most: a root that holds more is cut short, and says so. */
const VISIT_BUDGET = 20_000;
/** Repositories and passed-over folders listed, at most. */
const LIST_MAX = 256;

export interface ScanProjectsInput {
  readonly roots: readonly string[];
  readonly maxDepth: 4;
  readonly git: GitRunner;
  /** Agent Comms' own folders, never walked. */
  readonly deniedFolders?: readonly string[] | undefined;
  /** The project that already names a repository, if any. */
  readonly known?: ((repo: string) => string | null) | undefined;
}

interface Worktree {
  readonly path: string;
  readonly branch: string | null;
  readonly bare: boolean;
}

/** `git worktree list --porcelain`: each worktree's path and branch, the main one first. */
export function parseWorktreeList(output: string): readonly Worktree[] {
  const found: Worktree[] = [];
  for (const block of output.split(/\n\s*\n/u)) {
    let path: string | null = null;
    let branch: string | null = null;
    let bare = false;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      else if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length);
      else if (line === 'bare') bare = true;
    }
    if (path?.startsWith('/')) found.push({ path, branch, bare });
  }
  return found;
}

/** A hidden step in `path` below `base` — but `.claude/worktrees`, which is where Claude Code keeps worktrees. */
function hiddenBelow(path: string, base: string): boolean {
  if (!isInside(path, base)) return false;
  const steps = relative(base, path)
    .split(sep)
    .filter((step) => step.length > 0);
  return steps.some((step, index) => step.startsWith('.') && !(step === '.claude' && steps[index + 1] === 'worktrees'));
}

export async function scanProjects(input: ScanProjectsInput): Promise<ProjectScanResultV1> {
  const denied = (path: string) => (input.deniedFolders ?? []).some((folder) => isInside(path, folder));
  const skipped: ProjectScanSkippedV1[] = [];
  const passOver = (entry: ProjectScanSkippedV1) => {
    if (skipped.length < LIST_MAX && !skipped.some((each) => each.folder === entry.folder)) skipped.push(entry);
  };
  const skip = (folder: string, reason: Exclude<ProjectScanSkipReason, 'unsafe-config'>) =>
    passOver({ folder, reason });
  const repoFolders: string[] = [];
  let budget = VISIT_BUDGET;

  const visit = async (path: string, depth: number, root: string): Promise<void> => {
    if (budget <= 0) return;
    budget -= 1;
    if (denied(path)) return skip(path, 'agent-comms');
    let marker: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      marker = await lstat(join(path, '.git'));
    } catch {
      marker = undefined;
    }
    if (marker !== undefined && (marker.isDirectory() || marker.isFile())) {
      repoFolders.push(path);
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return skip(path, 'unreadable');
    }
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    const folders: string[] = [];
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        // Only to say what it is: a symlink is never walked.
        const target = await stat(child).catch(() => undefined);
        if (target?.isDirectory() === true) skip(child, 'symlink');
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) {
        if (entry.name === '.claude') {
          const worktrees = join(child, 'worktrees');
          const found = await lstat(worktrees).catch(() => undefined);
          if (found?.isDirectory() === true) folders.push(worktrees);
          else if (found?.isSymbolicLink() === true) skip(worktrees, 'symlink');
          continue;
        }
        skip(child, 'hidden');
        continue;
      }
      folders.push(child);
    }
    if (folders.length === 0) return;
    if (depth >= input.maxDepth) return skip(path, 'depth');
    for (const folder of folders) await visit(folder, depth + 1, root);
  };

  const roots: string[] = [];
  for (const root of input.roots) {
    roots.push(root);
    const found = await lstat(root).catch(() => undefined);
    if (found === undefined) skip(root, 'unreadable');
    else if (found.isSymbolicLink()) skip(root, 'symlink');
    else if (found.isDirectory()) await visit(root, 0, root);
    if (budget <= 0) skip(root, 'depth');
  }

  // Each checkout or worktree found says, through git, which repository it is and which worktrees it has.
  const byRepo = new Map<string, Map<string, { kind: 'checkout' | 'worktree'; defaultBranch: string | null }>>();
  const seen = new Set<string>();
  for (const folder of repoFolders) {
    if (seen.has(folder)) continue;
    const origin = await input.git.run(['config', '--get', 'remote.origin.url'], folder);
    const repo = origin.code === 0 ? foldGitHubRepo(origin.stdout.trim()) : null;
    if (repo === null) {
      seen.add(folder);
      continue;
    }
    const listed = await input.git.run(['worktree', 'list', '--porcelain'], folder);
    const worktrees = listed.code === 0 ? parseWorktreeList(listed.stdout) : [];
    const entries = worktrees.length > 0 ? worktrees : [{ path: folder, branch: null, bare: false }];
    const main = entries[0] as Worktree;
    const group = byRepo.get(repo) ?? new Map();
    for (const [index, worktree] of entries.entries()) {
      if (worktree.bare) continue;
      let real: string;
      try {
        real = await realpath(worktree.path);
      } catch {
        continue;
      }
      seen.add(real);
      if (denied(real)) {
        skip(real, 'agent-comms');
        continue;
      }
      const base = index === 0 ? dirname(real) : dirname(main.path);
      const scanRoot = roots.find((root) => isInside(real, root));
      if (index > 0 && (hiddenBelow(real, base) || (scanRoot !== undefined && hiddenBelow(real, scanRoot)))) {
        skip(real, 'hidden');
        continue;
      }
      if (group.has(real)) continue;
      // The gate, in each folder: its config as git reads it there (a worktree's own scope, an include its git
      // directory matches), the key named and its scope, never its value.
      const refusal = await repoConfigRefusal(input.git, real);
      if (refusal?.code === 'REPO_CONFIG_UNSAFE') {
        passOver({ folder: real, reason: 'unsafe-config', key: refusal.key, scope: refusal.scope });
        continue;
      }
      if (refusal !== null) {
        skip(real, 'unreadable');
        continue;
      }
      group.set(
        real,
        index === 0 ? { kind: 'checkout', defaultBranch: worktree.branch } : { kind: 'worktree', defaultBranch: null },
      );
    }
    seen.add(folder);
    if (group.size > 0) byRepo.set(repo, group);
  }

  const repos = [...byRepo.entries()]
    .sort(([left], [right]) => compareUtf8(left, right))
    .slice(0, LIST_MAX)
    .map(([repo, group]) => ({
      repo,
      known: input.known?.(repo) ?? null,
      folders: [...group.entries()]
        .map(([folder, entry]) => ({ folder, kind: entry.kind, defaultBranch: entry.defaultBranch }))
        .sort(
          (left, right) =>
            (left.kind === right.kind ? 0 : left.kind === 'checkout' ? -1 : 1) ||
            compareUtf8(left.folder, right.folder),
        ),
    }));
  return { roots, repos, skipped };
}
