import { join } from 'node:path';

/**
 * Owner options that keep a test's event service out of the person's real home (the second look at 0.33.0, after a
 * test read the person's claude-stream relay token): the agent-sessions home is a folder under the test's own temporary
 * one, which holds no relay. Spread it first, so a test that sets its own agent sessions still decides.
 */
export function noRealHome(root: string): { readonly agentSessions: { readonly homeDirectory: string } } {
  return { agentSessions: { homeDirectory: join(root, 'no-home') } };
}
