import { EventControlClient } from '../control/client.ts';
import type { PersonSetupOrigin } from '../domain/judge-setup.ts';
import type { LaneWindowIdentity } from '../domain/lanes.ts';
import type { AgentSessionsIntegrationV1 } from '../runtime/agent-sessions.ts';
import type { SessionQueueDropResultV1, SessionQueueListResultV1 } from '../runtime/session-queue.ts';

/*
 * Agent sessions through claude-stream (0.33.0 design §3.5). Where Agent Comms finds the person's relay is the
 * person's: `integration show` and `integration set agent-sessions` run from the app or their terminal, the CLI refuses
 * the event service's MCP server and an agent's shell first, and no MCP tool reads or sets it. The busy queue is the
 * person's to read and drop from; over MCP the event service's server passes the window it runs in as `caller`, and a
 * bound window sees only its own lane's items (routing B4).
 */

interface Options {
  readonly stateDir?: string | undefined;
  /** The agent window asking, as the event service's MCP server works it out; absent for the person. */
  readonly caller?: LaneWindowIdentity | undefined;
}

/** The settings of `integration set agent-sessions`; each one given replaces its setting. */
export interface AgentSessionsSettingsArgs {
  readonly relayHome?: string | undefined;
  readonly relayPort?: number | 'default' | undefined;
  readonly allowFolders?: readonly string[] | undefined;
  readonly removeFolders?: readonly string[] | undefined;
}

/** Where the relay is, whether it is ready, and how many items wait for a busy session; never its token. */
export async function integrationShow(integration: string, options: Options = {}): Promise<AgentSessionsIntegrationV1> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('integration-show', {
    integration,
  })) as AgentSessionsIntegrationV1;
}

/** Sets where the relay is, or a folder a file part may be read from: the person's own, from their origin only. */
export async function integrationSet(
  integration: string,
  settings: AgentSessionsSettingsArgs,
  options: Options & { readonly origin: PersonSetupOrigin },
): Promise<AgentSessionsIntegrationV1> {
  const args = Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined));
  return (await new EventControlClient({ stateDir: options.stateDir, clientName: options.origin }).request(
    'integration-set',
    { integration, ...args },
  )) as AgentSessionsIntegrationV1;
}

/** The items waiting for a busy session: every one for the person, a bound window's own lane's for a window. */
export async function sessionQueueList(options: Options = {}): Promise<SessionQueueListResultV1> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request(
    'session-queue-list',
    options.caller === undefined ? {} : { caller: options.caller },
  )) as SessionQueueListResultV1;
}

/** Drops a waiting item: its delivery is cancelled and its sealed record purged — the person's, at once. */
export async function sessionQueueDrop(deliveryId: string, options: Options = {}): Promise<SessionQueueDropResultV1> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('session-queue-drop', {
    deliveryId,
  })) as SessionQueueDropResultV1;
}
