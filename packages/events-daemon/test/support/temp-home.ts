import { join } from 'node:path';

/**
 * Owner options that keep a test's event service out of the person's real home (the second look at 0.33.0, after a
 * test read the person's claude-stream relay token): the owner's home seam is a folder under the test's own temporary
 * one, which holds no relay, so lanes and agent sessions look there. Spread it first, so a test that sets its own home
 * still decides.
 */
export function noRealHome(root: string): { readonly homeDirectory: string } {
  return { homeDirectory: join(root, 'no-home') };
}
