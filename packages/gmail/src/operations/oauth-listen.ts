import { aboutFlow } from '../auth/flows.ts';
import { startLoopback } from '../auth/loopback.ts';
import type { GmailContext } from '../context.ts';

/**
 * The detached half of a two-step sign-in: it holds the loopback port open while the person works through Google's
 * consent screens, and writes what comes back into the flow's outcome file for `--finish` to collect.
 *
 * It is started by `startSignIn` and is not meant to be run by hand, so its command is hidden from `--help`.
 */
export async function runOauthListener(context: GmailContext, flowId: string): Promise<void> {
  const flow = await context.flows.get(flowId);
  const port = Number(context.env.AGENT_COMMS_LOOPBACK_PORT ?? '') || undefined;
  const listener = await startLoopback({
    state: flow.state,
    port,
    timeoutMs: Math.max(1000, Date.parse(flow.expiresAt) - context.now().getTime()),
    about: aboutFlow(flow),
  });
  await context.flows.patch(flowId, {
    redirectUri: listener.redirectUri,
    port: listener.port,
    listenerPid: process.pid,
  });

  // The parent is waiting for exactly this before it prints the link; afterwards the two share only files.
  process.send?.({ type: 'ready', port: listener.port });
  process.disconnect?.();

  const result = await listener.result;
  await listener.close();
  if ('code' in result) {
    await context.flows.recordOutcome(flowId, { code: result.code });
  } else if ('error' in result) {
    await context.flows.recordOutcome(flowId, { error: result.error, description: result.description });
  }
  // On a timeout nothing is written: the flow expires on its own, and `--finish` says so.
}
