/**
 * Whether a version the local release just sent is visible on the registry yet.
 *
 * Kept out of `scripts/release.mjs` so it can be tested: that script refuses to publish anywhere but an interactive
 * terminal, so nothing after its publish can be reached from a test, and this is the part that decides whether a
 * release that went out is reported as one.
 *
 * `npm view` reads the public packument, which is CDN-cached and can lag minutes behind a successful publish —
 * badly so just after npm maintenance. The first version of this check used it, ran immediately, and announced
 * that a publish which had in fact succeeded had "not arrived". That is the worst way to be wrong: it invites
 * someone to burn the version number and publish 0.1.1 over a perfectly good 0.1.0.
 *
 * `npm dist-tag ls` goes to the authenticated registry path instead and was accurate within seconds of the same
 * publish. It is tried first; the packument is a fallback, and the caller retries before giving up.
 *
 * **Read the line for the tag the release went out under.** A prerelease is published under `next`, and `latest`
 * then still names the previous stable version, so a check that read `latest` could never see a `-rc.1` arrive: it
 * reported ten failed attempts and exited 1 after a publish that had succeeded. And when that line does not name the
 * version yet, ask for the exact version before concluding anything, rather than trusting one endpoint's lag.
 *
 * `npm` runs the npm CLI with the given arguments and returns its trimmed output, or null when it fails.
 */
export function isVisible({ name, version, distTag, npm }) {
  const tags = npm(['dist-tag', 'ls', name]);
  const tagged = tags?.split('\n').find((line) => line.startsWith(`${distTag}:`));
  if (tagged?.slice(distTag.length + 1).trim() === version) return true;
  return npm(['view', `${name}@${version}`, 'version']) === version;
}
