/**
 * Which sections the installed CLI can fill (DA12). A section that needs a later CLI says "Update agent-communications
 * to use this" and calls nothing.
 */

/**
 * The first version of each feature. `layaJudge` is the events service's own version (its `--version`), the first that
 * ships phase E2's Laya status and disable (`allowlist.rs`, `LAYA_JUDGE_VERSION`); `judges` is too, the first with
 * judges at all (Phase E, 0.17.0), whose `judge kinds list` and `judges list` the Judges section reads
 * (`JUDGE_KINDS_VERSION`), and `queue`, the first with the action queue (`QUEUE_VERSION`). The rest are core's:
 * `activity` is the first with the activity log (`ACTIVITY_VERSION`).
 */
export const GATES = {
  behaviour: '0.22.0',
  profiles: '0.22.0',
  standing: '0.23.0',
  updateStatus: '0.24.0',
  layaJudge: '0.25.0',
  judges: '0.17.0',
  activity: '0.29.0',
  queue: '0.30.0',
} as const;

export type Feature = keyof typeof GATES;

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function triple(version: string): [number, number, number] | null {
  const match = VERSION.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * True when `installed` is `needed` or later, as Rust's `version::at_least` reads it: a pre-release of a version
 * counts as that version (a pull request's build is `<version>-<branch>`), and a version that cannot be read has
 * nothing.
 */
export function atLeast(installed: string | null, needed: string): boolean {
  const have = installed === null ? null : triple(installed);
  const want = triple(needed);
  if (have === null || want === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (have[index] !== want[index]) return (have[index] ?? 0) > (want[index] ?? 0);
  }
  return true;
}

/** Whether the installed CLI has `feature`. */
export function supports(installed: string | null, feature: Feature): boolean {
  return atLeast(installed, GATES[feature]);
}
