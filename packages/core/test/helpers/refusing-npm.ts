import type { UpdateDeps } from '../../src/operations/update.ts';

/**
 * What an update reads and runs — the registry, `npm ls`, the installers, the provenance check — each refusing, and
 * recording that it was asked: what a read that promises to ask npm nothing is run against. `now` is the clock the
 * daily check reads by, so a test can say whether that check is due.
 */
export function refusingNpm(now: () => Date): { deps: UpdateDeps; asked: string[] } {
  const asked: string[] = [];
  const refuse = (what: string) => async (): Promise<never> => {
    asked.push(what);
    throw new Error(`${what} was asked, and nothing here may ask npm`);
  };
  return {
    asked,
    deps: {
      latestVersion: refuse('latestVersion'),
      globalPackages: refuse('globalPackages'),
      installGlobal: refuse('installGlobal'),
      installRuntime: refuse('installRuntime'),
      releaseFacts: refuse('releaseFacts'),
      registry: refuse('registry'),
      verifyRelease: refuse('verifyRelease'),
      now,
    },
  };
}
