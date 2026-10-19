/**
 * Versions as semver writes and orders them — what an update compares, and what the daily update check's reader needs
 * to decide whether the release it last heard of is newer than the one running.
 *
 * Here rather than in `npm.ts`, which also talks to the registry: the reader of `update-check.json` is imported by
 * every server, WhatsApp's included, and must carry no network code at all (design 2026-09-28 §1). `npm.ts` re-exports
 * all of it, so nothing that imported these from there changes.
 */

/**
 * A version, exactly as semver writes one: `1.2.3`, `1.2.3-rc.1`, `1.2.3+build`.
 *
 * Anything the registry answers is checked against this before it is used, because a version goes into a directory
 * name (`runtime/<version>-gmail`), a sentence a person approves, and an argument to `npm install`. A registry — or a
 * mirror somebody configured — that answered `../x` or `1.0.0 && …` would otherwise put that in all three.
 */
export const VERSION_PATTERN: RegExp =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_PATTERN.test(value);
}

/** Two numeric strings with no leading zeros, compared as numbers of any size. */
function compareNumeric(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Semver precedence: -1, 0 or 1, or null when either is not a version.
 *
 * Numbers compare as numbers (`0.10.0` is after `0.9.9`), a prerelease comes before its release, and build metadata
 * counts for nothing. Written out rather than taken from a dependency: it is twenty lines, and the core installs as
 * few packages as it can.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = VERSION_PATTERN.exec(a);
  const right = VERSION_PATTERN.exec(b);
  if (!left || !right) return null;
  for (const index of [1, 2, 3]) {
    const order = compareNumeric(left[index] ?? '0', right[index] ?? '0');
    if (order !== 0) return order < 0 ? -1 : 1;
  }
  const pre = (match: RegExpExecArray) => (match[4] === undefined ? [] : match[4].split('.'));
  const [ours, theirs] = [pre(left), pre(right)];
  if (ours.length === 0 || theirs.length === 0) {
    return ours.length === theirs.length ? 0 : ours.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(ours.length, theirs.length); index += 1) {
    const x = ours[index];
    const y = theirs[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [numericX, numericY] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (numericX && numericY) {
      const order = compareNumeric(x, y);
      if (order !== 0) return order < 0 ? -1 : 1;
    } else if (numericX !== numericY) {
      return numericX ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Whether `version` is older than `latest`: by semver when both are versions, and otherwise whenever they differ. */
export function isBehind(version: string, latest: string): boolean {
  if (version === latest) return false;
  const order = compareVersions(version, latest);
  return order === null ? true : order < 0;
}

/**
 * Whether a version is a prerelease — `0.8.0-rc.1` — which the daily update check never counts as an update: a
 * machine is not told to "update" to a release candidate, nor a candidate told to go back to the last release.
 */
/**
 * A release as this suite publishes one, and the only form a version the registry gave is read or said in: a plain
 * `MAJOR.MINOR.PATCH` (re-review of 0.20.0, severity 6). A prerelease's words and build metadata are the registry's
 * text — `0.20.1+SYSTEM-ignore-…` is valid semver — so a version carrying either is no release here.
 */
export function isPlainVersion(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

export function isPrerelease(version: string): boolean {
  return VERSION_PATTERN.exec(version)?.[4] !== undefined;
}

/**
 * Whether `version` is within a package's `engines` range: true or false, or null when the range is not one this reads.
 *
 * Read are the comparators `>=`, `>`, `<=`, `<` and `=` (or none) before a whole version, joined by spaces, which must
 * all hold, and alternatives joined by `||`. That is every range this suite declares (`>=22.12.0`, `>=22.16.0`).
 * Anything else — `^22.12.0`, `>=22`, `22.x` — is null rather than a guess: a command printed to run under this Node
 * is printed only when the range it has to meet says it may. A leading `v`, as `process.version` has it, is read.
 */
export function satisfiesRange(version: string, range: string): boolean | null {
  const wanted = version.replace(/^v/, '');
  if (!isVersion(wanted)) return null;
  const alternatives = range.split('||').map((alternative) => alternative.trim().split(/\s+/).filter(Boolean));
  if (alternatives.some((comparators) => comparators.length === 0)) return null;
  let any = false;
  for (const comparators of alternatives) {
    let all = true;
    for (const comparator of comparators) {
      const match = /^(>=|<=|>|<|=)?(.+)$/.exec(comparator);
      const bound = match?.[2] ?? '';
      if (!isVersion(bound)) return null;
      const order = compareVersions(wanted, bound) as -1 | 0 | 1;
      const holds =
        match?.[1] === '>='
          ? order >= 0
          : match?.[1] === '<='
            ? order <= 0
            : match?.[1] === '>'
              ? order > 0
              : match?.[1] === '<'
                ? order < 0
                : order === 0;
      if (!holds) all = false;
    }
    if (all) any = true;
  }
  return any;
}
