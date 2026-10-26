/**
 * Which sections the installed CLI can fill (DA12). A section that needs a later CLI says "Update agent-communications
 * to use this" and calls nothing.
 */

/**
 * The first version of each feature. `layaJudge` is the events service's own version (its `--version`), the first that
 * ships phase E2's Laya status and disable (`allowlist.rs`, `LAYA_JUDGE_VERSION`); `judges` is too, the first with
 * judges at all (Phase E, 0.17.0), whose `judge kinds list` and `judges list` the Judges section reads
 * (`JUDGE_KINDS_VERSION`), `queue`, the first with the action queue (`QUEUE_VERSION`), and `lanes`, the first with
 * lanes (`LANES_VERSION`), and `judgeSetup`, the first with judge setup and AI provider keys (`JUDGE_SETUP_VERSION`). The
 * rest are core's: `activity` is the first with the activity log (`ACTIVITY_VERSION`). `messages` is both's
 * (`MESSAGES_VERSION`): core's `activity items`, and the events service's `messages list`. `ruleEditor` is the events
 * service's (`RULE_EDITOR_VERSION`, 0.33.0): editing a rule in the app, Analyse and Settings → Integrations.
 * `labelChanges` is core's (`LABEL_APP_APPROVAL_VERSION`, 0.34.0): Your agents changes the label's word, name and
 * exceptions, each loosening approved in the app; an older core shows the label read-only.
 * `severalServers` and `bringUpToDate` are core's (0.34.0, `connections.rs`): several servers added to an app in one
 * approval (`MCP_SEVERAL_VERSION`), and `update --check` read and `update` approved in the app
 * (`UPDATE_APP_APPROVAL_VERSION`).
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
  lanes: '0.31.0',
  judgeSetup: '0.32.0',
  messages: '0.32.0',
  ruleEditor: '0.33.0',
  labelChanges: '0.34.0',
  severalServers: '0.34.0',
  bringUpToDate: '0.34.0',
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
