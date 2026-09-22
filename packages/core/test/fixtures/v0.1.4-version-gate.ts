/**
 * The version check from `parseConfig` in 0.1.4 (`git show v0.1.4:packages/core/src/config.ts`, lines 338–354),
 * frozen, with its constant inlined.
 *
 * Published releases cannot change, and this is the only part of one that decides what happens when it meets a file a
 * later release wrote. Kept here so a test can hold every config this release writes against it — the published
 * code cannot be imported (CI checks out without tags), and the behaviour it pins must not drift with the source.
 */
const CONFIG_VERSION = 1;

export class FrozenConfigError extends Error {
  readonly code = 'CONFIG';
}

export function parseConfigAsReleased014(text: string, source = 'config.json'): unknown {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FrozenConfigError(`${source} is not valid JSON`);
  }
  const version = (raw as { version?: unknown } | null)?.version;
  if (version !== CONFIG_VERSION) {
    throw new FrozenConfigError(
      `${source} has version ${String(version)}; this release reads version ${CONFIG_VERSION}`,
    );
  }
  return raw;
}
